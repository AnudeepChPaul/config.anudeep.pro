import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { GitRepository } from '@config/src/git/repository.js';
import { logCaught, logged, type MethodLog } from '@config/src/logging.js';
import { FileWriter } from '@config/src/store/file-writer.js';
import type { JournalEntry, WriteJournal } from '@config/src/store/write-journal.js';

export interface SyncGitPort {
  readonly status: () => Promise<boolean>;
  readonly commit: (message: string) => Promise<string>;
  readonly push: () => Promise<{ pushed: boolean; reason?: string }>;
}

export interface SyncResult {
  readonly kind: 'clean' | 'synced' | 'deferred';
  readonly files: readonly string[];
  readonly commit?: string;
  readonly reason?: string;
}

export type SyncTrigger = 'manual' | 'timer' | 'idle';

export function gitSyncPort(repository: GitRepository): SyncGitPort {
  return {
    status: () => repository.hasWorkingTreeChanges(),
    commit: async (message) => {
      const commit = await repository.commitWorkingTree(message);
      if (!commit) throw new Error('Git reported changes but produced no commit');
      return commit;
    },
    push: () => repository.push(),
  };
}

/** Mirrors the source-of-truth tree and owns the commit boundary. */
export class SyncEngine {
  private running: Promise<SyncResult> | null = null;

  constructor(
    private readonly source: string,
    private readonly destination: string,
    private readonly journal: WriteJournal,
    private readonly git: SyncGitPort,
    private readonly onSynced?: (commit: string) => void,
    private readonly readSnapshot?: () => Promise<ReadonlyMap<string, string>>,
    private readonly log?: MethodLog,
  ) {}

  async syncNow(_trigger: SyncTrigger = 'manual'): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = logged(this.log, 'config.sync', { logger: 'store.sync' }, () =>
      this.performSync(),
    );
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async performSync(): Promise<SyncResult> {
    const handle = await this.journal.rotate();
    const files = this.readSnapshot
      ? await mirrorSnapshot(await this.readSnapshot(), this.destination)
      : await mirrorTree(this.source, this.destination);
    const changed = await this.git.status();
    if (!changed) {
      await this.journal.discard(handle);
      return { kind: 'clean', files };
    }

    const entries = await this.journal.drain(handle);
    const commit = await this.git.commit(composeCommitMessage(files, entries));
    await this.journal.discard(handle);
    const pushed = await this.git.push();
    if (pushed.pushed) this.onSynced?.(commit);
    return pushed.pushed
      ? { kind: 'synced', files, commit }
      : { kind: 'deferred', files, commit, reason: pushed.reason };
  }
}

export function composeCommitMessage(
  files: readonly string[],
  entries: readonly JournalEntry[],
): string {
  const actors = [...new Set(entries.map((entry) => entry.actor))].sort();
  const keys = [...new Set(entries.flatMap((entry) => entry.keys))].sort();
  const namespaces = [
    ...new Set(files.filter((file) => file.startsWith('config/')).map((file) => file.slice(7, -5))),
  ].sort();
  const subject =
    namespaces.length > 0
      ? `sync ${namespaces.join(', ')}`
      : `sync ${files.join(', ') || 'database'}`;
  return [
    subject,
    '',
    keys.length > 0 ? `Keys: ${keys.join(', ')}` : 'Keys: none',
    actors.length > 0 ? `Actors: ${actors.join(', ')}` : 'Actors: unknown',
    '',
    ...actors.map((actor) => `Actor: ${actor}`),
  ].join('\n');
}

async function mirrorTree(source: string, destination: string): Promise<string[]> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const sourceFiles = new Set(await collectFiles(source));
  const destinationFiles = await collectFiles(destination);
  for (const file of destinationFiles) {
    if (!sourceFiles.has(file)) await rm(join(destination, file), { force: true });
  }
  for (const file of sourceFiles) {
    const from = join(source, file);
    const to = join(destination, file);
    await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
    await cp(from, to, { force: true, preserveTimestamps: true });
  }
  return [
    ...new Set([...sourceFiles, ...destinationFiles].filter((file) => file !== '.git')),
  ].sort();
}

async function mirrorSnapshot(
  source: ReadonlyMap<string, string>,
  destination: string,
): Promise<string[]> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const previous = await collectFiles(destination);
  const writer = new FileWriter();
  for (const file of previous) if (!source.has(file)) await writer.remove(join(destination, file));
  for (const [file, content] of source) await writer.write(join(destination, file), content);
  return [...new Set([...source.keys(), ...previous])].sort();
}

async function collectFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true }).catch(
    (error: unknown) => {
      logCaught(error, 'config.sync.readdir.failed', { logger: 'store.sync' });
      return [];
    },
  )) {
    if (entry.name === '.git' || entry.name === '.journal' || entry.name === '.revision') continue;
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, path)));
    else result.push(relative(root, join(root, path)));
  }
  return result;
}
