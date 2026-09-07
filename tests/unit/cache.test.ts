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
 * It holds decrypted values, so it is deliberately memory-only: persistence lives in
 * SnapshotStore, which writes ciphertext. See tests/unit/snapshot.test.ts.
 */

const tree = (commit: string, namespaces: Record<string, Record<string, unknown>>): ConfigTree => ({
  commit,
  namespaces: new Map(Object.entries(namespaces)),
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('ConfigCache reads', () => {
  it('serves a namespace it was loaded with', () => {
    const cache = new ConfigCache();
    cache.reload(tree(SHA_A, { 'iam/prod': { MFA_ENFORCEMENT: 'all' } }));

    expect(cache.get('iam', 'prod')).toEqual({ MFA_ENFORCEMENT: 'all' });
  });

  it('returns null for a namespace the tree does not define', () => {
    // Not an empty object: "no file for this service" and "a file that overrides nothing" are
    // different answers, and the client merges them over defaults differently.
    const cache = new ConfigCache();
    cache.reload(tree(SHA_A, { 'iam/prod': {} }));

    expect(cache.get('audit', 'prod')).toBeNull();
    expect(cache.get('iam', 'prod')).toEqual({});
  });

  it('exposes the commit it is serving', () => {
    const cache = new ConfigCache();
    cache.reload(tree(SHA_A, {}));

    expect(cache.commit()).toBe(SHA_A);
  });

  it('has no commit before it is first loaded', () => {
    expect(new ConfigCache().commit()).toBeNull();
  });

  it('hands out values a caller cannot mutate back into the cache', () => {
    // One consumer scribbling on the object it was handed must not change what the next
    // consumer reads.
    const cache = new ConfigCache();
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
    const cache = new ConfigCache();
    cache.reload(tree(SHA_A, { 'iam/prod': { A: 1, B: 2 } }));
    cache.reload(tree(SHA_B, { 'iam/prod': { A: 1 } }));

    expect(cache.get('iam', 'prod')).toEqual({ A: 1 });
  });

  it('drops a namespace whose file was removed', () => {
    const cache = new ConfigCache();
    cache.reload(tree(SHA_A, { 'iam/prod': { A: 1 }, 'api/prod': { B: 2 } }));
    cache.reload(tree(SHA_B, { 'iam/prod': { A: 1 } }));

    expect(cache.get('api', 'prod')).toBeNull();
    expect(cache.commit()).toBe(SHA_B);
  });
});
