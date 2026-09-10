import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DBEngine } from '@config/src/store/data-layer.js';
import { SyncEngine } from '@config/src/store/sync-engine.js';
import { type JournalEntry, WriteJournal } from '@config/src/store/write-journal.js';
import { describe, expect, it } from 'vitest';

const entry: JournalEntry = {
  actor: 'operator@example.com',
  path: 'config/web/prod.yaml',
  keys: ['CHECKOUT_URL'],
  revision: '1',
  timestamp: '2026-09-10T00:00:00.000Z',
};

describe('SyncEngine', () => {
  it('mirrors the supplied committed database snapshot without reading later file contents', async () => {
    const source = await mkdtemp(join(tmpdir(), 'config-sync-source-'));
    const destination = await mkdtemp(join(tmpdir(), 'config-sync-destination-'));
    const db = new DBEngine(source);
    await db.write({ path: 'flags.yaml', content: 'snapshot' });
    const snapshot = await db.snapshot();
    await db.write({ path: 'flags.yaml', content: 'later' });
    const engine = new SyncEngine(
      source,
      destination,
      new WriteJournal(join(source, '.journal')),
      {
        status: async () => true,
        commit: async () => 'commit',
        push: async () => ({ pushed: true }),
      },
      undefined,
      async () => snapshot.files,
    );
    await engine.syncNow();
    expect(await readFile(join(destination, 'flags.yaml'), 'utf8')).toBe('snapshot');
  });
  it('mirrors files, commits attribution, and pushes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'config-sync-source-'));
    const destination = await mkdtemp(join(tmpdir(), 'config-sync-destination-'));
    await mkdir(join(source, 'config', 'web'), { recursive: true });
    await writeFile(join(source, 'config', 'web', 'prod.yaml'), 'CHECKOUT_URL: https://x\n');
    const journal = new WriteJournal(join(source, '.journal'));
    await journal.append(entry);
    const calls: string[] = [];
    const engine = new SyncEngine(source, destination, journal, {
      status: async () => true,
      commit: async (message) => {
        calls.push(message);
        return 'commit-1';
      },
      push: async () => ({ pushed: true }),
    });

    const result = await engine.syncNow();

    expect(result).toMatchObject({ kind: 'synced', commit: 'commit-1' });
    expect(await readFile(join(destination, 'config', 'web', 'prod.yaml'), 'utf8')).toContain(
      'https://x',
    );
    expect(calls[0]).toContain('operator@example.com');
  });

  it('returns clean and does not commit when Git reports no changes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'config-sync-source-'));
    const destination = await mkdtemp(join(tmpdir(), 'config-sync-destination-'));
    const journal = new WriteJournal(join(source, '.journal'));
    let committed = false;
    const engine = new SyncEngine(source, destination, journal, {
      status: async () => false,
      commit: async () => {
        committed = true;
        return 'never';
      },
      push: async () => ({ pushed: true }),
    });

    expect(await engine.syncNow()).toMatchObject({ kind: 'clean' });
    expect(committed).toBe(false);
  });

  it('reports the Git commit only after a successful push', async () => {
    const source = await mkdtemp(join(tmpdir(), 'config-sync-source-'));
    const destination = await mkdtemp(join(tmpdir(), 'config-sync-destination-'));
    await writeFile(join(source, 'flags.yaml'), 'version: 1\nflags: {}\n');
    const journal = new WriteJournal(join(source, '.journal'));
    const synced: string[] = [];
    const engine = new SyncEngine(
      source,
      destination,
      journal,
      {
        status: async () => true,
        commit: async () => 'commit-2',
        push: async () => ({ pushed: true }),
      },
      (commit) => synced.push(commit),
    );

    await engine.syncNow();

    expect(synced).toEqual(['commit-2']);
  });
});
