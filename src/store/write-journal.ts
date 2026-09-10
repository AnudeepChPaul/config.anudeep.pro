import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(this.pending, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async rotate(): Promise<JournalHandle> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await rm(this.sending, { force: true });
    try {
      await rename(this.pending, this.sending);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(this.sending, '', { encoding: 'utf8', mode: 0o600 });
    }
    return { path: this.sending };
  }

  async drain(handle: JournalHandle): Promise<JournalEntry[]> {
    const source = await readFile(handle.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return source
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JournalEntry);
  }

  async discard(handle: JournalHandle): Promise<void> {
    await rm(handle.path, { force: true });
  }

  async recover(): Promise<void> {
    let orphaned = '';
    try {
      orphaned = await readFile(this.sending, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (orphaned.length === 0) return;

    let pending = '';
    try {
      pending = await readFile(this.pending, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(this.pending, `${orphaned}${pending}`, { encoding: 'utf8', mode: 0o600 });
    await rm(this.sending, { force: true });
  }
}
