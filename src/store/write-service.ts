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

export interface StageRequest {
  readonly service: string;
  readonly environment: string;
  /** Key to new value. `undefined` removes the override. */
  readonly changes: Readonly<Record<string, unknown>>;
}

/** Recognises a SOPS-encrypted value, to confirm the secrets really were encrypted. */
const ENCRYPTED = /^ENC\[AES256_GCM,/;

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
      if (changes.length === 0 && existing) return ok(existing);

      const validation = this.options.schemas().validate(request.service, next);
      if (!validation.ok) {
        return err({
          code: 'invalid',
          detail: 'the change does not match the schema',
          errors: validation.error,
        });
      }

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
        ...changes.map((c) => asDraftChange(c.key, c.oldValue, c.newValue)),
      ];

      const draft: Draft = {
        namespace,
        document,
        changes: dedupeByKey(recorded),
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
   * Commits the drafts for the given namespaces as ONE commit, and pushes.
   *
   * All or nothing: a partial publish would commit half of what the operator selected and
   * report success, leaving the rest to be discovered later. The scope they chose is the unit
   * of change, which is also why it is one commit and not one per environment — two commits
   * would let a rollback undo half a decision that was made whole.
   */
  async publish(
    namespaces: readonly string[],
    message: string,
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<SaveResult, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    if (!message.trim()) {
      return err({ code: 'invalid', detail: 'a publish message is required' });
    }

    return this.lock.withLock(async () => {
      const selected: Draft[] = [];
      for (const namespace of namespaces) {
        const draft = await drafts.get(namespace);
        if (!draft) {
          return err({ code: 'nothing_staged', detail: `nothing is staged for ${namespace}` });
        }
        selected.push(draft);
      }
      if (selected.length === 0) {
        return err({ code: 'nothing_staged', detail: 'nothing was selected' });
      }

      // A draft was assembled from the values committed when it was made. If the file has moved
      // since — someone editing on GitHub — publishing would silently overwrite them.
      const sources = await this.options.repository.readSources();
      for (const draft of selected) {
        const current = sources.sources.get(draft.namespace);
        if (current !== undefined && draft.basedOn !== undefined && draft.basedOn !== current) {
          return err({
            code: 'conflict',
            detail: `${draft.namespace} changed since this edit was made`,
            currentCommit: sources.commit,
          });
        }
      }

      const files: Record<string, string> = {};
      const keys: KeyChange[] = [];
      for (const draft of selected) {
        files[`config/${draft.namespace}.yaml`] = draft.document;
        for (const change of draft.changes) {
          keys.push({ key: change.key, oldValue: change.from, newValue: change.to });
        }
      }

      const commitMessage = this.trailers.build(
        actor,
        {
          message,
          service: [...new Set(selected.map((d) => d.namespace.split('/')[0]))].join(', '),
          environment: [...new Set(selected.map((d) => d.namespace.split('/')[1]))].join(', '),
          keys,
        },
        context,
      );

      const commit = await this.options.repository.writeAndCommit(files, commitMessage);
      await drafts.remove(selected.map((d) => d.namespace));
      const push = await this.options.repository.push();

      return ok({
        commit,
        changedKeys: keys.map((k) => k.key),
        published: push.pushed,
      });
    });
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
