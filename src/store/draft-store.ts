import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Namespace } from '../identity/types.js';

/**
 * Edits that have been made but not published.
 *
 * The write path used to commit on save, which made "saved" mean durable. Publishing per
 * environment or per product needs a state between the two, and that state is genuinely weaker
 * than a commit: a draft is one file on one box, with no history and no off-host copy.
 *
 * So the rules here are about limiting what that costs. Drafts outlive the process, and a
 * draft never holds a secret in plaintext — the document is stored exactly as it would be
 * committed, already encrypted, so this file is no more revealing than the repository is.
 */

export interface DraftChange {
  readonly key: string;
  /** Omitted for a secret: showing the old value in a diff leaks what encryption protects. */
  readonly from: unknown;
  readonly to: unknown;
  readonly secret: boolean;
}

/**
 * One press of Save.
 *
 * A namespace accumulates these until it is published: they are what the console counts —
 * "Publish 2 drafts?" — and what a publish turns into one line each in the commit body.
 *
 * Nobody types a commit message here, so a save records only facts: which keys it touched, who
 * made it, and when. The line is generated from those at publish time.
 */
export interface DraftSave {
  /** The keys this save touched, named in its generated commit line. */
  readonly keys: readonly string[];
  /**
   * The document as it stood after this save — encrypted, exactly as it would be committed.
   *
   * Kept so a save can be dropped the way git drops a commit: the others replay onto the
   * committed state, each contributing the values ITS snapshot holds. Without it, dropping a
   * save could only revert its keys all the way to what is committed, losing an earlier save's
   * value for the same key.
   */
  readonly document?: string;
  readonly actor: string;
  readonly at: number;
}

export interface Draft {
  readonly namespace: Namespace;
  /** The full document as it would be committed — secrets already encrypted. */
  readonly document: string;
  readonly changes: readonly DraftChange[];
  /** One entry per save action, oldest first. */
  readonly saves: readonly DraftSave[];
  readonly actor: string;
  readonly updatedAt: number;
  /**
   * The committed file text this draft was built from, for detecting a change underneath it.
   *
   * `null` means there was no file: the draft creates the namespace. That is different from
   * absent, which only means an older build wrote this draft and recorded nothing — and it is
   * the difference between "the file appearing underneath me is a conflict" and "I cannot tell".
   */
  readonly basedOn?: string | null;
  /**
   * Other files this draft commits alongside its document, by path.
   *
   * A product is three kinds of file at once — an entry in services.yaml, a schema, and one
   * environment file per environment — and they have to land together. A registry entry without
   * its schema is a product nobody can open; a schema without its entry is a file nothing reads.
   * Publishing them as separate drafts would leave the registry in one of those states for as
   * long as it took to publish the second.
   */
  readonly files?: Readonly<Record<string, string>>;
}

export class DraftError extends Error {}

const isDraft = (value: unknown): value is Draft => {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Partial<Draft>;
  return (
    typeof d.namespace === 'string' &&
    typeof d.document === 'string' &&
    Array.isArray(d.changes) &&
    typeof d.actor === 'string' &&
    typeof d.updatedAt === 'number'
  );
};

/**
 * A retirement staged before retirements had a draft of their own.
 *
 * Retiring a product used to attach the flag to the namespace's draft, under a declared
 * environment — and everything that counts drafts counts per declared environment. So such a
 * draft reads as an environment update: counted as work waiting to publish, marking the
 * environment pending, and offered to the publish action, which would then fail, because the
 * change it carries names no key any schema declares.
 *
 * Recognised by shape rather than by a flag: it carries a schema file with the retirement in it,
 * and it changes no real value. A draft that also changes a value is left exactly where it is —
 * moving it would drag that value change out of the environment it belongs to.
 */
const RETIREMENT_ONLY = /^retiring$/;

const asRetirement = (draft: Draft): Draft => {
  const [service, environment] = draft.namespace.split('/');
  if (!service || environment === 'retiring') return draft;

  const schema = draft.files?.[`schema/${service}.yaml`];
  if (!schema || !/^retiring:\s*true\s*$/m.test(schema)) return draft;
  if (draft.changes.some((change) => !RETIREMENT_ONLY.test(change.key))) return draft;

  return {
    ...draft,
    namespace: `${service}/retiring` as Draft['namespace'],
    // `retiring` was never a key: it is a property of the schema, and a change naming it would
    // be validated against a schema that has no such key and refused.
    changes: [],
  };
};

/**
 * A draft written before saves existed is one save.
 *
 * Reading it as none would put "Publish 0 drafts" over a draft that plainly holds changes, and
 * every draft on disk at the moment this ships is one of these.
 */
const withSaves = (draft: Draft): Draft =>
  Array.isArray(draft.saves) && draft.saves.length > 0
    ? draft
    : {
        ...draft,
        saves: [
          {
            keys: draft.changes.map((change) => change.key),
            actor: draft.actor,
            at: draft.updatedAt,
            // The document this save stood at IS the draft as it was written, so a later drop
            // replays it from here rather than from whatever the draft becomes. Without it, the
            // replay fell back to the final document — which holds exactly the values a drop is
            // removing, so the drop restored them.
            document: draft.document,
          },
        ],
      };

export class DraftStore {
  constructor(private readonly path: string) {}

  async all(): Promise<Draft[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      // Absent or truncated. Neither is a reason to refuse to start; it means nothing is staged.
      return [];
    }

    const drafts = (parsed as { drafts?: unknown })?.drafts;
    if (!Array.isArray(drafts)) return [];

    // One malformed entry discards itself, not the rest: losing every pending change because
    // one is unreadable would be a worse outcome than losing the one.
    return drafts.filter(isDraft).map(withSaves).map(asRetirement);
  }

  async get(namespace: Namespace): Promise<Draft | null> {
    return (await this.all()).find((draft) => draft.namespace === namespace) ?? null;
  }

  async put(draft: Draft): Promise<void> {
    for (const save of draft.saves ?? []) {
      // These key names are rendered into the console and into a commit body; refusing beats
      // discovering what a non-array stringifies to in either place.
      if (!Array.isArray(save.keys) || save.keys.some((key) => typeof key !== 'string')) {
        throw new DraftError(`refusing to store a malformed save for '${draft.namespace}'`);
      }
    }

    for (const change of draft.changes) {
      // The one way plaintext could reach this file is a caller forgetting to strip it.
      // Refusing beats trusting every future call site to remember.
      if (change.secret && (change.to !== undefined || change.from !== undefined)) {
        throw new DraftError(`refusing to stage a value for the secret key '${change.key}'`);
      }
    }

    const rest = (await this.all()).filter((d) => d.namespace !== draft.namespace);
    await this.write([...rest, draft]);
  }

  /** Drops the named drafts. Unknown namespaces are ignored: a raced publish must not error. */
  async remove(namespaces: readonly Namespace[]): Promise<void> {
    const dropping = new Set(namespaces);
    await this.write((await this.all()).filter((draft) => !dropping.has(draft.namespace)));
  }

  private async write(drafts: readonly Draft[]): Promise<void> {
    const temp = join(dirname(this.path), `.${process.pid}.drafts.tmp`);
    // 0600 and temp-then-rename, as for every other file this service owns: a crash leaves the
    // old set or the new one, never half of either.
    await writeFile(temp, JSON.stringify({ drafts }), { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temp, this.path);
    } catch (cause) {
      await unlink(temp).catch(() => {});
      throw cause;
    }
  }
}
