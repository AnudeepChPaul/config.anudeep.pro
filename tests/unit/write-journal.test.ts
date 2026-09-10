import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JournalEntry, WriteJournal } from '@config/src/store/write-journal.js';
import { describe, expect, it } from 'vitest';

const entry: JournalEntry = {
  actor: 'operator@example.com',
  path: 'flags.yaml',
  keys: ['NEW_CHECKOUT'],
  revision: '1',
  timestamp: '2026-09-10T00:00:00.000Z',
};

describe('WriteJournal', () => {
  it('appends and drains entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-journal-test-'));
    const journal = new WriteJournal(root);
    await journal.append(entry);

    const handle = await journal.rotate();
    expect(await journal.drain(handle)).toEqual([entry]);
  });

  it('discards a rotated journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-journal-test-'));
    const journal = new WriteJournal(root);
    await journal.append(entry);
    const handle = await journal.rotate();
    await journal.discard(handle);

    expect(await journal.drain(handle)).toEqual([]);
  });

  it('recovers an orphaned sending journal into pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-journal-test-'));
    const journal = new WriteJournal(root);
    await journal.append(entry);
    const handle = await journal.rotate();
    await journal.recover();

    expect(await readFile(handle.path, 'utf8').catch(() => '')).toBe('');
    const next = await journal.rotate();
    expect(await journal.drain(next)).toEqual([entry]);
  });
});
