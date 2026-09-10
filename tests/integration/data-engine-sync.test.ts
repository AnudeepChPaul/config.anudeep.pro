import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepository } from '@config/src/git/repository.js';
import { gitSyncPort, SyncEngine } from '@config/src/store/sync-engine.js';
import { WriteJournal } from '@config/src/store/write-journal.js';
import { describe, expect, it } from 'vitest';
import { TestRepo } from '../helpers.js';

describe('database to Git synchronization', () => {
  it('creates one real Git commit from database files', async () => {
    const repo = await TestRepo.create();
    const db = await mkdtemp(join(tmpdir(), 'config-db-integration-'));
    await mkdir(join(db, 'config', 'web'), { recursive: true });
    await writeFile(join(db, 'config', 'web', 'prod.yaml'), 'ENABLED: true\n');
    const journal = new WriteJournal(join(db, '.journal'));
    await journal.append({
      actor: 'operator@example.com',
      path: 'config/web/prod.yaml',
      keys: ['ENABLED'],
      revision: '1',
      timestamp: new Date(0).toISOString(),
    });
    const engine = new SyncEngine(db, repo.dir, journal, gitSyncPort(new GitRepository(repo.dir)));

    const result = await engine.syncNow();

    expect(result.kind).toBe('deferred');
    expect(await repo.git('show', '--format=%s', '--no-patch', 'HEAD')).toContain('sync web/prod');
    await rm(db, { recursive: true, force: true });
  });

  it('mirrors deletions into a real Git commit', async () => {
    const repo = await TestRepo.create();
    await repo.commit({ 'config/web/prod.yaml': 'ENABLED: true\n' });
    const db = await mkdtemp(join(tmpdir(), 'config-db-integration-'));
    const journal = new WriteJournal(join(db, '.journal'));
    const engine = new SyncEngine(db, repo.dir, journal, gitSyncPort(new GitRepository(repo.dir)));

    const result = await engine.syncNow();

    expect(result.kind).toBe('deferred');
    expect(await repo.git('ls-files', 'config/web/prod.yaml')).toBe('');
    await rm(db, { recursive: true, force: true });
  });
});
