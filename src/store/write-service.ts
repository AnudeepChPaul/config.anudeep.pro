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
}

export interface SaveError {
  readonly code: 'conflict' | 'invalid' | 'secret_not_encrypted' | 'failed';
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
      return ok({ commit: head, changedKeys: [] });
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

    return ok({ commit, changedKeys: changes.map((c) => c.key) });
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
