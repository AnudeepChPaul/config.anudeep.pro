import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logCaught, logged } from '@config/src/logging.js';

export interface JournalEntry {
  readonly actor: string;
  readonly path: string;
  readonly keys: readonly string[];
  readonly revision: string;
  readonly timestamp: string;
}

export interface JournalHandle {
  readonly path: string;
}

/** Durable attribution for writes that have not yet reached Git. */
export class WriteJournal {
  private readonly pending: string;
  private readonly sending: string;

  constructor(private readonly root: string) {
    this.pending = join(root, 'pending.jsonl');
    this.sending = join(root, 'sending.jsonl');
  }

  async append(entry: JournalEntry): Promise<void> {
    return logged(undefined, 'config.journal.append', { logger: 'store.write-journal' }, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await appendFile(this.pending, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    });
  }

  async rotate(): Promise<JournalHandle> {
    return logged(undefined, 'config.journal.rotate', { logger: 'store.write-journal' }, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await rm(this.sending, { force: true });
      try {
        await rename(this.pending, this.sending);
      } catch (error) {
        logCaught(error, 'config.journal.rotate.rename.failed', { logger: 'store.write-journal' });
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(this.sending, '', { encoding: 'utf8', mode: 0o600 });
      }
      return { path: this.sending };
    });
  }

  async drain(handle: JournalHandle): Promise<JournalEntry[]> {
    return logged(undefined, 'config.journal.drain', { logger: 'store.write-journal' }, async () =>
      parseJsonl(await readFile(handle.path, 'utf8').catch(missingFile)),
    );
  }

  /** Read pending (and orphan sending) without rotate. */
  async peek(): Promise<JournalEntry[]> {
    return logged(undefined, 'config.journal.peek', { logger: 'store.write-journal' }, async () => {
      const sending = await readFile(this.sending, 'utf8').catch(missingFile);
      const pending = await readFile(this.pending, 'utf8').catch(missingFile);
      return parseJsonl(`${sending}${pending}`);
    });
  }

  async discard(handle: JournalHandle): Promise<void> {
    return logged(undefined, 'config.journal.discard', { logger: 'store.write-journal' }, () =>
      rm(handle.path, { force: true }),
    );
  }

  async recover(): Promise<void> {
    return logged(undefined, 'config.journal.recover', { logger: 'store.write-journal' }, async () => {
      let orphaned = '';
      try {
        orphaned = await readFile(this.sending, 'utf8');
      } catch (error) {
        logCaught(error, 'config.journal.recover.sending.failed', { logger: 'store.write-journal' });
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (orphaned.length === 0) return;

      let pending = '';
      try {
        pending = await readFile(this.pending, 'utf8');
      } catch (error) {
        logCaught(error, 'config.journal.recover.pending.failed', { logger: 'store.write-journal' });
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFile(this.pending, `${orphaned}${pending}`, { encoding: 'utf8', mode: 0o600 });
      await rm(this.sending, { force: true });
    });
  }
}

const missingFile = (error: NodeJS.ErrnoException): string => {
  logCaught(error, 'config.journal.read.failed', { logger: 'store.write-journal' });
  if (error.code === 'ENOENT') return '';
  throw error;
};

const parseJsonl = (source: string): JournalEntry[] =>
  source
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
