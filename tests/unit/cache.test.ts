import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigCache } from '@config/src/store/cache.js';
import type { ConfigTree } from '@config/src/store/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The cache is what every read is actually served from, so that no service read depends on git,
 * the network, or the disk being healthy at the moment it asks.
 *
 * Its disk half exists for one moment only: process start. If the repo is unreadable then, the
 * service serves the last tree it knew rather than nothing at all.
 */

const tree = (commit: string, namespaces: Record<string, Record<string, unknown>>): ConfigTree => ({
  commit,
  namespaces: new Map(Object.entries(namespaces)),
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let dir: string;
let snapshotPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'config-cache-'));
  snapshotPath = join(dir, 'snapshot.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ConfigCache reads', () => {
  it('serves a namespace it was loaded with', () => {
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': { MFA_ENFORCEMENT: 'all' } }));

    expect(cache.get('iam', 'prod')).toEqual({ MFA_ENFORCEMENT: 'all' });
  });

  it('returns null for a namespace the tree does not define', () => {
    // Not an empty object: "no file for this service" and "a file that overrides nothing" are
    // different answers, and the client merges them over defaults differently.
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': {} }));

    expect(cache.get('audit', 'prod')).toBeNull();
    expect(cache.get('iam', 'prod')).toEqual({});
  });

  it('exposes the commit it is serving', () => {
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, {}));

    expect(cache.commit()).toBe(SHA_A);
  });

  it('has no commit before it is first loaded', () => {
    expect(new ConfigCache(snapshotPath).commit()).toBeNull();
  });

  it('hands out values a caller cannot mutate back into the cache', () => {
    // One consumer scribbling on the object it was handed must not change what the next
    // consumer reads.
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': { MFA_ENFORCEMENT: 'all' } }));

    const first = cache.get('iam', 'prod') as Record<string, unknown>;
    expect(() => {
      first.MFA_ENFORCEMENT = 'optional';
    }).toThrow();

    expect(cache.get('iam', 'prod')).toEqual({ MFA_ENFORCEMENT: 'all' });
  });
});

describe('ConfigCache.reload', () => {
  it('replaces the tree wholesale rather than merging into it', () => {
    // A deleted key must actually disappear. Merging would make deletion impossible — exactly
    // the operation you need during an incident to drop a bad override.
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': { A: 1, B: 2 } }));
    cache.reload(tree(SHA_B, { 'iam/prod': { A: 1 } }));

    expect(cache.get('iam', 'prod')).toEqual({ A: 1 });
  });

  it('drops a namespace whose file was removed', () => {
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': { A: 1 }, 'api/prod': { B: 2 } }));
    cache.reload(tree(SHA_B, { 'iam/prod': { A: 1 } }));

    expect(cache.get('api', 'prod')).toBeNull();
    expect(cache.commit()).toBe(SHA_B);
  });
});

describe('ConfigCache disk snapshot', () => {
  it('round-trips a tree through disk', async () => {
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': { MFA_ENFORCEMENT: 'all', FP_COMPONENTS: ['ua'] } }));
    await cache.persistToDisk();

    const restored = new ConfigCache(snapshotPath);
    expect(await restored.loadFromDisk()).toBe(true);
    expect(restored.commit()).toBe(SHA_A);
    expect(restored.get('iam', 'prod')).toEqual({ MFA_ENFORCEMENT: 'all', FP_COMPONENTS: ['ua'] });
  });

  it('reports no snapshot on a first-ever boot instead of throwing', async () => {
    // Principle 5: a first boot with nothing cached must still start. The absence of a snapshot
    // is an ordinary state, not an error.
    const cache = new ConfigCache(snapshotPath);

    expect(await cache.loadFromDisk()).toBe(false);
    expect(cache.commit()).toBeNull();
  });

  it('survives a corrupt snapshot rather than failing to boot', async () => {
    // A snapshot truncated by a power cut must not be the thing that keeps the service down.
    await writeFile(snapshotPath, '{"commit": "aaa', 'utf8');
    const cache = new ConfigCache(snapshotPath);

    expect(await cache.loadFromDisk()).toBe(false);
    expect(cache.commit()).toBeNull();
  });

  it('survives a snapshot of the wrong shape', async () => {
    await writeFile(snapshotPath, JSON.stringify({ commit: 42, namespaces: 'nope' }), 'utf8');
    const cache = new ConfigCache(snapshotPath);

    expect(await cache.loadFromDisk()).toBe(false);
  });

  it('leaves no partial file behind when it writes', async () => {
    // The snapshot is written to a temp name and renamed, so a crash mid-write leaves either
    // the old snapshot or the new one — never half of either.
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': { A: 1 } }));
    await cache.persistToDisk();

    expect(await readdir(dir)).toEqual(['snapshot.json']);
  });

  it('overwrites an older snapshot in place', async () => {
    const cache = new ConfigCache(snapshotPath);
    cache.reload(tree(SHA_A, { 'iam/prod': { A: 1 } }));
    await cache.persistToDisk();
    cache.reload(tree(SHA_B, { 'iam/prod': { A: 2 } }));
    await cache.persistToDisk();

    const restored = new ConfigCache(snapshotPath);
    await restored.loadFromDisk();

    expect(restored.commit()).toBe(SHA_B);
    expect(restored.get('iam', 'prod')).toEqual({ A: 2 });
  });

  it('does nothing when asked to persist before anything is loaded', async () => {
    // Writing an empty snapshot over a good one would turn a failed boot into a lost
    // last-known-good.
    const cache = new ConfigCache(snapshotPath);
    await cache.persistToDisk();

    expect(await readdir(dir)).toEqual([]);
  });
});
