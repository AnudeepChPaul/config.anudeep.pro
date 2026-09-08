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

export interface Draft {
  readonly namespace: Namespace;
  /** The full document as it would be committed — secrets already encrypted. */
  readonly document: string;
  readonly changes: readonly DraftChange[];
  readonly actor: string;
  readonly updatedAt: number;
  /** The committed file text this draft was built from, for detecting a change underneath it. */
  readonly basedOn?: string;
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
    return drafts.filter(isDraft);
  }

  async get(namespace: Namespace): Promise<Draft | null> {
    return (await this.all()).find((draft) => draft.namespace === namespace) ?? null;
  }

  async put(draft: Draft): Promise<void> {
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
