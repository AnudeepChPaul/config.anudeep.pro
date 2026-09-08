import { stringify as stringifyYaml } from 'yaml';
import {
  type Actor,
  CommitTrailerBuilder,
  type KeyChange,
  type RequestContext,
} from '../git/commit-trailers.js';
import type { GitRepository } from '../git/repository.js';
import { WriteLock } from '../git/write-lock.js';
import { err, ok, type Result } from '../identity/types.js';
import type { SchemaSet, ValidationError } from '../schema/validator.js';
import type { Draft, DraftChange, DraftStore } from './draft-store.js';
import type { ConfigLoader } from './loader.js';
import { bumpedVersion, VERSION_KEY, versionOf } from './metadata.js';
import type { SopsEncryptor } from './sops-encryptor.js';
import type { RawConfig, Sha } from './types.js';

/**
 * The write path: validate, check for a stale base, encrypt, commit.
 *
 * Everything happens under one lock, because git has no concurrency control and the stale check
 * alone cannot catch two writers who read the same HEAD before either wrote.
 */

export interface SaveRequest {
  readonly service: string;
  readonly environment: string;
  /** The commit the editor loaded. A save based on anything but HEAD is refused. */
  readonly baseCommit: Sha;
  /** Key to new value. `undefined` deletes the override. */
  readonly changes: Readonly<Record<string, unknown>>;
  readonly message: string;
}

export interface SaveResult {
  readonly commit: Sha;
  readonly changedKeys: readonly string[];
  /**
   * Whether the commit reached the remote.
   *
   * False is not a failure. The commit is durable locally and already being served; the push is
   * how it becomes off-host backup, and the background retry will catch up. The UI shows this
   * as unpublished rather than as an error.
   */
  readonly published: boolean;
}

export interface SaveError {
  readonly code: 'conflict' | 'invalid' | 'secret_not_encrypted' | 'failed' | 'nothing_staged';
  readonly detail: string;
  readonly errors?: readonly ValidationError[];
  /** On a conflict, the commit the editor should reload from. */
  readonly currentCommit?: Sha;
}

export interface ConfigWriteServiceOptions {
  readonly repository: GitRepository;
  readonly loader: ConfigLoader;
  readonly encryptor: SopsEncryptor;
  /** Re-read per save, so a schema change takes effect without a restart. */
  readonly schemas: () => SchemaSet;
  readonly lock?: WriteLock;
  /** Where unpublished edits live. Absent keeps the old commit-on-save behaviour. */
  readonly drafts?: DraftStore;
}

/**
 * A namespace to publish.
 *
 * There is no key narrowing: a draft publishes whole. Shipping some of a draft's keys and
 * re-staging the rest gave a button that counted drafts and an outcome that shipped keys — two
 * different things behind one number. To hold a change back now, undo the change.
 */
export interface PublishSelection {
  readonly namespace: string;
}

export interface PromoteRequest {
  readonly service: string;
  readonly from: string;
  readonly to: string;
  readonly keys: readonly string[];
}

export interface StageRequest {
  readonly service: string;
  readonly environment: string;
  /** Key to new value. `undefined` removes the override. */
  readonly changes: Readonly<Record<string, unknown>>;
  /**
   * Keys the operator ticked. A tick on a key whose value has not moved is how you say "send
   * this one along" — to a publish, and from there to the next environment — so it is written
   * into the draft too, or the intent is lost the moment the page is left.
   */
  readonly selected?: readonly string[];
}

/** Recognises a SOPS-encrypted value, to confirm the secrets really were encrypted. */
const ENCRYPTED = /^ENC\[AES256_GCM,/;

/**
 * One draft's line in a commit body: where it was, the day the edit was made, and what it
 * touched.
 *
 * The date is the SAVE's, not the publish's — the line describes an edit, and stamping every
 * line with the publish time would make them all claim the same moment, which is the one thing
 * the body is there to distinguish.
 *
 * Key names appear, a secret's included: a name is not a value, and the commit trailers already
 * carry key names.
 */
function draftLine(namespace: string, save: { keys: readonly string[]; at: number }): string {
  const [service = '', environment = ''] = namespace.split('/');
  const day = new Date(save.at).toISOString().slice(0, 10);
  return `[${service}-${environment}] ${day} ${[...save.keys].sort().join(' ')}`.trimEnd();
}

export class ConfigWriteService {
  private readonly lock: WriteLock;
  private readonly trailers = new CommitTrailerBuilder();

  constructor(private readonly options: ConfigWriteServiceOptions) {
    this.lock = options.lock ?? new WriteLock();
  }

  async save(
    request: SaveRequest,
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<SaveResult, SaveError>> {
    return this.lock.withLock(() => this.saveLocked(request, actor, context));
  }

  private async saveLocked(
    request: SaveRequest,
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<SaveResult, SaveError>> {
    const { repository } = this.options;
    const namespace = `${request.service}/${request.environment}`;

    const head = await repository.headCommit();
    if (request.baseCommit !== head) {
      // The editor is looking at values someone else has already replaced. Applying this would
      // silently discard their change, and the history would show two clean commits.
      return err({
        code: 'conflict',
        detail: 'the configuration changed since this page was loaded',
        currentCommit: head,
      });
    }

    const sources = await repository.readSources();
    const tree = await this.options.loader.resolve(sources);
    const current = tree.namespaces.get(namespace) ?? {};

    const { next, changes } = applyChanges(current, request.changes);
    if (changes.length === 0) {
      return ok({ commit: head, changedKeys: [], published: true });
    }

    const validation = this.options.schemas().validate(request.service, next);
    if (!validation.ok) {
      return err({
        code: 'invalid',
        detail: 'the change does not match the schema',
        errors: validation.error,
      });
    }

    // Keys are sorted so a diff shows the key that changed rather than every key moving.
    const plaintext = stringifyYaml(sortKeys(next));
    const encrypted = await this.options.encryptor.encrypt(namespace, plaintext);

    const unprotected = this.secretsLeftInPlaintext(request.service, next, encrypted);
    if (unprotected.length > 0) {
      // The schema says these are secret; `.sops.yaml` did not encrypt them. Neither file is
      // obviously wrong on its own, and committing would publish the secret in the clear.
      return err({
        code: 'secret_not_encrypted',
        detail: `.sops.yaml does not encrypt: ${unprotected.join(', ')}`,
      });
    }

    const message = this.trailers.build(
      actor,
      {
        message: request.message,
        service: request.service,
        environment: request.environment,
        keys: changes,
      },
      context,
    );

    const commit = await repository.writeAndCommit(
      { [`config/${namespace}.yaml`]: encrypted },
      message,
    );

    // After the commit, deliberately. A push failure must not undo a save that is already
    // durable and already being served — during a GitHub outage an operator still has to be
    // able to close registration.
    const push = await repository.push();

    return ok({ commit, changedKeys: changes.map((c) => c.key), published: push.pushed });
  }

  /**
   * Validates and encrypts a change, and holds it as a draft. Does not commit.
   *
   * The write path used to commit here, which made "saved" mean durable. Publishing per
   * environment or per product needs this middle state — but validation stays at this end of
   * it, so an operator learns a value is wrong when they type it rather than when they try to
   * ship three environments at once.
   */
  async stage(request: StageRequest, actor: Actor): Promise<Result<Draft, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    return this.lock.withLock(async () => {
      const namespace = `${request.service}/${request.environment}`;
      const sources = await this.options.repository.readSources();
      const tree = await this.options.loader.resolve(sources);
      const committed = tree.namespaces.get(namespace) ?? {};

      // Built on any earlier draft for this namespace, so two edits to the same environment
      // accumulate rather than the second discarding the first.
      const existing = await drafts.get(namespace);
      const base = existing
        ? await this.options.loader.resolveOne(namespace, existing.document)
        : committed;

      const { next, changes } = applyChanges(base, request.changes);
      // Ticked, but not edited. Recorded as itself rather than as a value moving to itself, so
      // the change list says selected and not "optional → optional".
      const edited = new Set(changes.map((change) => change.key));
      const selectedOnly = (request.selected ?? []).filter(
        (key) => !edited.has(key) && key in base,
      );

      // Nothing moved and nothing was ticked. Writing a draft anyway would put an empty pending
      // marker on the environment and offer a publish with no content behind it.
      if (changes.length === 0 && selectedOnly.length === 0) {
        // An existing draft with nothing in it is not a draft: it puts a pending marker on the
        // environment and offers a publish with no content behind it.
        if (existing && existing.changes.length > 0) return ok(existing);
        if (existing) await drafts.remove([namespace]);
        return err({ code: 'nothing_staged', detail: 'nothing changed' });
      }

      const validation = this.options.schemas().validate(request.service, next);
      if (!validation.ok) {
        return err({
          code: 'invalid',
          detail: 'the change does not match the schema',
          errors: validation.error,
        });
      }

      // A revision of the document, so the counter moves here and nowhere else. Publishing
      // writes down what a draft already decided; counting that as a second revision would make
      // the number mean nothing in particular. It is numbered from what is COMMITTED rather
      // than from the draft in hand, so a namespace edited five times before publishing arrives
      // at the next number rather than five past it.
      // From the draft in hand, not from the committed file: five edits before a publish are
      // five revisions of the document, and numbering from what is committed would collapse
      // them into one.
      next[VERSION_KEY] = bumpedVersion(base);

      const plaintext = stringifyYaml(sortKeys(next));
      const document = await this.options.encryptor.encrypt(namespace, plaintext);

      const unprotected = this.secretsLeftInPlaintext(request.service, next, document);
      if (unprotected.length > 0) {
        return err({
          code: 'secret_not_encrypted',
          detail: `.sops.yaml does not encrypt: ${unprotected.join(', ')}`,
        });
      }

      // A secret's before and after are dropped here, not at render time. The console shows
      // this list on hover, and a value that never enters it cannot leak out of it.
      const schemas = this.options.schemas();
      const asDraftChange = (key: string, from: unknown, to: unknown): DraftChange =>
        schemas.isSecret(request.service, key)
          ? { key, from: undefined, to: undefined, secret: true }
          : { key, from, to, secret: false };

      const recorded: DraftChange[] = [
        ...(existing?.changes ?? []).map((c) => asDraftChange(c.key, c.from, c.to)),
        // Selected first, so an edit to the same key in this save replaces it: dedupeByKey
        // keeps the last entry, and an edit says more than a selection does.
        ...selectedOnly.map((key) => asDraftChange(key, base[key], base[key])),
        ...changes.map((c) => asDraftChange(c.key, c.oldValue, c.newValue)),
      ];

      const draft: Draft = {
        namespace,
        document,
        changes: dedupeByKey(recorded),
        // One entry per press of Save. This is what the console counts — "Publish 2 drafts?" —
        // and what a publish turns into one generated line each. Nobody types a message, so a
        // save records only facts: what it touched, who made it, and when.
        saves: [
          ...(existing?.saves ?? []),
          {
            keys: [...new Set([...changes.map((change) => change.key), ...selectedOnly])],
            actor: actor.email,
            at: Date.now(),
          },
        ],
        actor: actor.email,
        updatedAt: Date.now(),
        // What the namespace looked like when this draft was built, so publishing can tell
        // whether the file moved underneath it.
        ...(sources.sources.has(namespace)
          ? { basedOn: existing?.basedOn ?? sources.sources.get(namespace) }
          : {}),
      };
      await drafts.put(draft);
      return ok(draft);
    });
  }

  /**
   * Commits what was selected as ONE commit, and pushes.
   *
   * A selection may narrow a namespace to some of its staged keys: the console lets an operator
   * tick individual changes and ship only those. Whatever is left stays staged, rebased onto the
   * commit that just happened — carrying the old base forward would make the next publish either
   * conflict or quietly revert the key just published.
   *
   * Still all-or-nothing across the selection: a partial publish would commit half of what was
   * chosen and report success.
   */
  async publish(
    selections: readonly (string | PublishSelection)[],
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<SaveResult, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    // A bare namespace means "everything staged there", which is now the only thing a selection
    // can mean: drafts publish whole.
    const chosenSelections: PublishSelection[] = selections.map((entry) =>
      typeof entry === 'string' ? { namespace: entry } : entry,
    );
    if (chosenSelections.length === 0) {
      return err({ code: 'nothing_staged', detail: 'nothing was selected' });
    }

    return this.lock.withLock(async () => {
      const sources = await this.options.repository.readSources();
      const tree = await this.options.loader.resolve(sources);
      const schemas = this.options.schemas();

      const files: Record<string, string> = {};
      const keyChanges: KeyChange[] = [];
      const summaryLines: string[] = [];
      let drafted = 0;

      for (const selection of chosenSelections) {
        const draft = await drafts.get(selection.namespace);
        if (!draft) {
          return err({
            code: 'nothing_staged',
            detail: `nothing is staged for ${selection.namespace}`,
          });
        }

        const current = sources.sources.get(selection.namespace);
        if (current !== undefined && draft.basedOn !== undefined && draft.basedOn !== current) {
          return err({
            code: 'conflict',
            detail: `${selection.namespace} changed since this edit was made`,
            currentCommit: sources.commit,
          });
        }

        const chosen = draft.changes.map((change) => change.key);

        // The draft holds the whole document with secrets already encrypted, so it is decrypted
        // in memory to read the values this commit is about to carry.
        const stagedConfig = await this.options.loader.resolveOne(
          selection.namespace,
          draft.document,
        );
        const committed = tree.namespaces.get(selection.namespace) ?? {};
        const service = selection.namespace.split('/')[0] ?? '';

        const next: Record<string, unknown> = { ...committed };
        for (const key of chosen) {
          if (key in stagedConfig) next[key] = stagedConfig[key];
          else delete next[key];
          keyChanges.push({ key, oldValue: committed[key], newValue: stagedConfig[key] });
        }

        // Carried from the draft, not recomputed: this commit IS that revision of the document,
        // and rebuilding a subset must not leave the file numbered as if it had never moved.
        next[VERSION_KEY] = versionOf(stagedConfig);

        const validation = schemas.validate(service, next);
        if (!validation.ok) {
          return err({
            code: 'invalid',
            detail: 'the change does not match the schema',
            errors: validation.error,
          });
        }

        const document = await this.options.encryptor.encrypt(
          selection.namespace,
          stringifyYaml(sortKeys(next)),
        );
        const unprotected = this.secretsLeftInPlaintext(service, next, document);
        if (unprotected.length > 0) {
          return err({
            code: 'secret_not_encrypted',
            detail: `.sops.yaml does not encrypt: ${unprotected.join(', ')}`,
          });
        }

        files[`config/${selection.namespace}.yaml`] = document;
        // One line per draft, in the order the saves were made.
        summaryLines.push(...draft.saves.map((save) => draftLine(selection.namespace, save)));
        drafted += draft.saves.length;
      }

      // Generated, never typed. An operator has better things to do mid-incident than compose a
      // subject line, and a generated one cannot be left as "wip".
      const scope = [...new Set(chosenSelections.map((s) => s.namespace))].join(', ');
      const message = [
        `Publish ${drafted} draft${drafted === 1 ? '' : 's'} in ${scope}`,
        '',
        ...summaryLines,
      ].join('\n');

      const commitMessage = this.trailers.build(
        actor,
        {
          message,
          service: [...new Set(chosenSelections.map((s) => s.namespace.split('/')[0]))].join(', '),
          environment: [...new Set(chosenSelections.map((s) => s.namespace.split('/')[1]))].join(
            ', ',
          ),
          keys: keyChanges,
        },
        context,
      );

      const commit = await this.options.repository.writeAndCommit(files, commitMessage);
      await drafts.remove(chosenSelections.map((s) => s.namespace));

      const push = await this.options.repository.push();

      return ok({ commit, changedKeys: keyChanges.map((k) => k.key), published: push.pushed });
    });
  }

  /**
   * Stages a published value from one environment into another.
   *
   * Only what the operator just shipped moves, and never a secret: SOPS gives each file its own
   * data key, so the source's ciphertext would not decrypt in the target. Refusing beats
   * skipping it silently, which would leave them believing it moved.
   */
  async promote(request: PromoteRequest, actor: Actor): Promise<Result<Draft, SaveError>> {
    const from = `${request.service}/${request.from}`;
    const schemas = this.options.schemas();

    const secrets = request.keys.filter((key) => schemas.isSecret(request.service, key));
    if (secrets.length > 0) {
      return err({
        code: 'invalid',
        detail: `cannot promote a secret (${secrets.join(', ')}) — set it directly in ${request.to}`,
      });
    }

    const tree = await this.options.loader.resolve(await this.options.repository.readSources());
    const source = tree.namespaces.get(from);
    if (!source) return err({ code: 'invalid', detail: `${from} has no configuration` });

    const missing = request.keys.filter((key) => !(key in source));
    if (missing.length > 0) {
      return err({ code: 'invalid', detail: `${from} does not set: ${missing.join(', ')}` });
    }

    const changes: Record<string, unknown> = {};
    for (const key of request.keys) changes[key] = source[key];

    return this.stage({ service: request.service, environment: request.to, changes }, actor);
  }

  /** Schema-secret keys that survived encryption as readable text. */
  private secretsLeftInPlaintext(service: string, config: RawConfig, encrypted: string): string[] {
    const schemas = this.options.schemas();
    const document = parseShallow(encrypted);
    return Object.keys(config).filter(
      (key) => schemas.isSecret(service, key) && !ENCRYPTED.test(document[key] ?? ''),
    );
  }
}

/** Applies the requested changes, reporting which keys actually moved. */
function applyChanges(
  current: RawConfig,
  changes: Readonly<Record<string, unknown>>,
): { next: Record<string, unknown>; changes: KeyChange[] } {
  const next: Record<string, unknown> = { ...current };
  const applied: KeyChange[] = [];

  for (const [key, newValue] of Object.entries(changes)) {
    const oldValue = current[key];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

    if (newValue === undefined) {
      delete next[key];
    } else {
      next[key] = newValue;
    }
    applied.push({ key, oldValue, newValue });
  }

  return { next, changes: applied };
}

/** Later entries win, so a re-edited key appears once with its newest value. */
function dedupeByKey(changes: readonly DraftChange[]): DraftChange[] {
  const byKey = new Map<string, DraftChange>();
  for (const change of changes) byKey.set(change.key, change);
  return [...byKey.values()];
}

function sortKeys(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
}

/** Top-level `key: value` pairs as raw text, enough to tell ciphertext from plaintext. */
function parseShallow(document: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of document.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (match?.[1]) pairs[match[1]] = match[2] ?? '';
  }
  return pairs;
}
