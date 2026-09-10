import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WriteLock } from '@config/src/git/write-lock.js';
import { bootstrapDb } from '@config/src/store/bootstrap-db.js';
import { assertNoSymlinks, databasePath } from '@config/src/store/database-path.js';
import { FileWriter } from '@config/src/store/file-writer.js';
import {
  contentHash,
  readOptional,
  type TransactionIntent,
  TransactionJournal,
} from '@config/src/store/transaction-journal.js';

export interface WriteRequest {
  readonly path: string;
  readonly content: string;
  /** null requires absence; undefined permits an unconditional write. */
  readonly expectedEtag?: string | null;
  readonly validate?: (
    content: string,
  ) => readonly { readonly key: string; readonly message: string }[];
  readonly actor?: string;
  readonly keys?: readonly string[];
}
export interface MutationRequest extends Omit<WriteRequest, 'content'> {
  readonly content: string | null;
}
export interface RemoveRequest extends Omit<WriteRequest, 'content' | 'validate'> {}
export interface ReadPrecondition {
  readonly path: string;
  readonly expectedEtag: string | null;
}
export interface CollectionPrecondition {
  readonly path: string;
  readonly files: readonly string[];
}
export interface WriteEvent {
  readonly path: string;
  readonly revision: string;
  readonly etag: string;
  readonly actor?: string;
  readonly keys: readonly string[];
  /** Stable across recovery; attribution consumers can deduplicate retries. */
  readonly transactionId?: string;
}
export type BatchWriteResult =
  | {
      readonly kind: 'written' | 'unchanged';
      readonly revision: string;
      readonly etags: ReadonlyMap<string, string>;
    }
  | {
      readonly kind: 'conflict';
      readonly path: string;
      readonly actual: string | null;
      readonly revision: string;
    }
  | {
      readonly kind: 'invalid';
      readonly path: string;
      readonly errors: readonly { key: string; message: string }[];
    };
export type WriteResult =
  | { readonly kind: 'written' | 'unchanged'; readonly etag: string; readonly revision: string }
  | {
      readonly kind: 'invalid';
      readonly etag: string;
      readonly errors: readonly { key: string; message: string }[];
      readonly revision: string;
    }
  | {
      readonly kind: 'conflict';
      readonly etag: string;
      readonly expected: string | null;
      readonly actual: string | null;
      readonly revision: string;
    };
export type RemoveResult =
  | { readonly kind: 'removed' | 'unchanged'; readonly etag: null; readonly revision: string }
  | {
      readonly kind: 'conflict';
      readonly etag: string | null;
      readonly expected: string | null;
      readonly actual: string | null;
      readonly revision: string;
    };

/** Per-file locks cover staging; one short publication lock protects revisions and snapshots. */
export class DBEngine {
  private readonly writer: FileWriter;
  private readonly journal: TransactionJournal;
  private readonly publication = new WriteLock();
  private readonly paths = new Map<string, WriteLock>();
  private ready: Promise<void> | undefined;
  private recoveryRequired = false;
  private readonly onWrite?: (event: WriteEvent) => Promise<void> | void;

  constructor(
    private readonly root: string,
    options: {
      readonly writer?: FileWriter;
      readonly onWrite?: (event: WriteEvent) => Promise<void> | void;
    } = {},
  ) {
    this.writer = options.writer ?? new FileWriter();
    this.journal = new TransactionJournal(root, this.writer);
    this.onWrite = options.onWrite;
  }

  /** Boot calls this before listeners/synchronization start. Reads also await first recovery. */
  async recover(): Promise<void> {
    this.ready ??= this.publication.withLock(async () => {
      for (const { id, intent } of await this.journal.pending()) await this.finish(id, intent);
    });
    await this.ready;
    this.assertHealthy();
  }

  async read(path: string): Promise<string | null> {
    databasePath(this.root, path);
    await this.recover();
    return this.publication.withLock(async () => {
      this.assertHealthy();
      return this.readUnlocked(path);
    });
  }

  async etag(path: string): Promise<string | null> {
    const content = await this.read(path);
    return content === null ? null : contentHash(content);
  }

  async revision(): Promise<string> {
    await this.recover();
    return this.publication.withLock(async () => {
      this.assertHealthy();
      return String(await this.revisionUnlocked());
    });
  }

  async snapshot(prefix = ''): Promise<{ revision: string; files: ReadonlyMap<string, string> }> {
    if (prefix) databasePath(this.root, prefix);
    await this.recover();
    return this.publication.withLock(async () => {
      this.assertHealthy();
      const files = new Map<string, string>();
      const visit = async (path: string): Promise<void> => {
        if (path) await assertNoSymlinks(this.root, path);
        let entries: Dirent[];
        try {
          entries = await readdir(join(this.root, path), { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          if (entry.name === '.journal' || entry.name === '.revision' || entry.name === '.git')
            continue;
          const child = path ? `${path}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) throw new Error(`symlink in database path: ${child}`);
          if (entry.isDirectory()) await visit(child);
          else if (entry.isFile()) {
            const content = await readOptional(join(this.root, child));
            if (content !== null) files.set(child, content);
          }
        }
      };
      await visit(prefix);
      return { revision: String(await this.revisionUnlocked()), files };
    });
  }

  async readAll(prefix = ''): Promise<ReadonlyMap<string, string>> {
    return (await this.snapshot(prefix)).files;
  }

  async bootstrapFrom(barePath: string): Promise<boolean> {
    const bootstrapped = await bootstrapDb(this.root, barePath);
    await this.recover();
    return bootstrapped;
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const result = await this.writeMany([request]);
    switch (result.kind) {
      case 'written':
      case 'unchanged':
        return {
          kind: result.kind,
          etag: result.etags.get(request.path) ?? '',
          revision: result.revision,
        };
      case 'conflict':
        return { ...result, etag: result.actual ?? '', expected: request.expectedEtag ?? null };
      case 'invalid':
        return {
          ...result,
          etag: (await this.etag(request.path)) ?? '',
          revision: await this.revision(),
        };
    }
  }

  /** Compatibility for existing callers; every mutation now uses the same locks and journal. */
  async writeBatch(requests: readonly WriteRequest[]): Promise<BatchWriteResult> {
    return this.writeMany(requests);
  }

  /** Caller orders visibility: create registry last; archive registry first; delete schema last. */
  async writeMany(
    requests: readonly MutationRequest[],
    checks: readonly ReadPrecondition[] = [],
    collections: readonly CollectionPrecondition[] = [],
  ): Promise<BatchWriteResult> {
    for (const check of checks) databasePath(this.root, check.path);
    for (const check of collections) databasePath(this.root, check.path);
    const paths = requests.map((request) => {
      databasePath(this.root, request.path);
      return request.path;
    });
    if (new Set(paths).size !== paths.length)
      throw new Error('duplicate database path in transaction');
    await this.recover();
    return this.withPaths([...paths].sort(), async () => {
      const errors = requests.flatMap((request) =>
        request.content === null ? [] : [...(request.validate?.(request.content) ?? [])],
      );
      if (errors.length) return { kind: 'invalid', path: requests[0]?.path ?? '', errors };
      const current = new Map<string, string | null>();
      for (const request of requests) current.set(request.path, await this.etag(request.path));
      for (const request of requests) {
        const actual = current.get(request.path) ?? null;
        if (request.expectedEtag !== undefined && request.expectedEtag !== actual) {
          return { kind: 'conflict', path: request.path, actual, revision: await this.revision() };
        }
      }
      const etags = new Map(
        requests.map((request) => [
          request.path,
          request.content === null ? '' : contentHash(request.content),
        ]),
      );
      const changed = requests.filter(
        (request) =>
          (request.content === null ? null : etags.get(request.path)) !== current.get(request.path),
      );
      const prepared = changed.length ? await this.journal.prepare(changed) : undefined;
      return this.publication.withLock(async () => {
        this.assertHealthy();
        for (const check of collections) {
          await assertNoSymlinks(this.root, check.path);
          const names = await readdir(databasePath(this.root, check.path)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return [];
              throw error;
            },
          );
          if (
            JSON.stringify(names.filter((name) => name.endsWith('.yaml')).sort()) !==
            JSON.stringify([...check.files].sort())
          ) {
            if (prepared) await this.journal.complete(prepared.id);
            return {
              kind: 'conflict',
              path: check.path,
              actual: null,
              revision: String(await this.revisionUnlocked()),
            };
          }
        }
        for (const check of checks) {
          const source = await this.readUnlocked(check.path);
          const actual = source === null ? null : contentHash(source);
          if (actual !== check.expectedEtag) {
            if (prepared) await this.journal.complete(prepared.id);
            return {
              kind: 'conflict',
              path: check.path,
              actual,
              revision: String(await this.revisionUnlocked()),
            };
          }
        }
        if (!prepared)
          return { kind: 'unchanged', revision: String(await this.revisionUnlocked()), etags };
        const revision = (await this.revisionUnlocked()) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('database revision exhausted');
        try {
          const intent = await this.journal.recordIntent(prepared, revision);
          await this.finish(prepared.id, intent);
        } catch (error) {
          this.recoveryRequired = true;
          throw error;
        }
        return { kind: 'written', revision: String(revision), etags };
      });
    });
  }

  async remove(request: RemoveRequest): Promise<RemoveResult> {
    const result = await this.writeMany([{ ...request, content: null }]);
    if (result.kind === 'invalid') throw new Error('unexpected deletion validation failure');
    if (result.kind === 'conflict')
      return { ...result, etag: result.actual, expected: request.expectedEtag ?? null };
    return {
      kind: result.kind === 'written' ? 'removed' : 'unchanged',
      etag: null,
      revision: result.revision,
    };
  }

  private async finish(id: string, intent: TransactionIntent): Promise<void> {
    const current = await this.revisionUnlocked();
    if (current > intent.revision || current < intent.revision - 1)
      throw new Error(`cannot recover transaction ${id}: unexpected revision`);
    await this.journal.apply(id, intent);
    if (current !== intent.revision)
      await this.writer.write(join(this.root, '.revision'), `${intent.revision}\n`);
    for (const file of intent.files)
      await this.onWrite?.({
        path: file.path,
        revision: String(intent.revision),
        etag: file.hash ?? '',
        ...(file.actor ? { actor: file.actor } : {}),
        keys: file.keys,
        transactionId: id,
      });
    await this.journal.complete(id);
  }

  private async readUnlocked(path: string): Promise<string | null> {
    await assertNoSymlinks(this.root, path);
    return readOptional(databasePath(this.root, path));
  }
  private async revisionUnlocked(): Promise<number> {
    const source = await readOptional(join(this.root, '.revision'));
    if (source === null) return 0;
    const value = Number(source.trim());
    if (!/^\d+\s*$/.test(source) || !Number.isSafeInteger(value) || value < 0)
      throw new Error('invalid database revision');
    return value;
  }
  private assertHealthy(): void {
    if (this.recoveryRequired)
      throw new Error('database recovery required; restart before reading or writing');
  }
  private async withPaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const [path, ...remaining] = paths;
    if (path === undefined) return operation();
    let lock = this.paths.get(path);
    if (!lock) {
      lock = new WriteLock();
      this.paths.set(path, lock);
    }
    return lock.withLock(() => this.withPaths(remaining, operation));
  }
}

export { contentHash as etagFor };
