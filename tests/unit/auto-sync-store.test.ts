import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoSyncStore } from '@config/src/store/auto-sync-store.js';
import { describe, expect, it } from 'vitest';

describe('AutoSyncStore', () => {
  it('reads missing file as off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-sync-'));
    expect(await new AutoSyncStore(root).read()).toBe(false);
  });

  it('round-trips true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-sync-'));
    const store = new AutoSyncStore(root);
    await store.write(true);
    expect(await store.read()).toBe(true);
  });

  it('treats corrupt JSON as off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-sync-'));
    await writeFile(join(root, 'auto-sync.json'), '{not json', 'utf8');
    expect(await new AutoSyncStore(root).read()).toBe(false);
  });
});
