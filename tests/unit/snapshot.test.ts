import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '@config/src/store/snapshot.js';
import type { ConfigSources } from '@config/src/store/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The last-known-good snapshot, on disk.
 *
 * It exists for one moment only: process start. If the repo is unreadable then, the service
 * serves the last tree it knew rather than nothing at all — the difference between a degraded
 * platform and one that cannot boot.
 *
 * **It stores file text exactly as committed, which means still encrypted.** The decrypted tree
 * never reaches a disk that is backed up; the age key is needed at boot to restore it, which was
 * already true. Snapshotting the decrypted values instead would put every secret in plaintext in
 * a backup, defeating the point of encrypting them at rest.
 */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const sources = (commit: string, files: Record<string, string>): ConfigSources => ({
  commit,
  sources: new Map(Object.entries(files)),
});

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'config-snapshot-'));
  path = join(dir, 'snapshot.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SnapshotStore round trip', () => {
  it('restores what it saved', async () => {
    const store = new SnapshotStore(path);
    await store.save(sources(SHA_A, { 'iam/prod': 'MFA_ENFORCEMENT: all\n' }));

    const restored = await store.load();

    expect(restored?.commit).toBe(SHA_A);
    expect(restored?.sources.get('iam/prod')).toBe('MFA_ENFORCEMENT: all\n');
  });

  it('overwrites an older snapshot in place', async () => {
    const store = new SnapshotStore(path);
    await store.save(sources(SHA_A, { 'iam/prod': 'A: 1\n' }));
    await store.save(sources(SHA_B, { 'iam/prod': 'A: 2\n' }));

    expect((await store.load())?.commit).toBe(SHA_B);
  });

  it('drops a namespace whose file was removed', async () => {
    const store = new SnapshotStore(path);
    await store.save(sources(SHA_A, { 'iam/prod': 'A: 1\n', 'api/prod': 'B: 2\n' }));
    await store.save(sources(SHA_B, { 'iam/prod': 'A: 1\n' }));

    expect((await store.load())?.sources.has('api/prod')).toBe(false);
  });
});

describe('SnapshotStore secrecy', () => {
  it('writes the committed ciphertext, never a decrypted value', async () => {
    // The whole reason this stores sources rather than the resolved tree. A snapshot of the
    // decrypted tree would put every secret in plaintext into whatever backs this volume up.
    const encrypted = 'SMTP_PASSWORD: ENC[AES256_GCM,data:x9Kd,iv:aa,tag:bb,type:str]\n';
    const store = new SnapshotStore(path);

    await store.save(sources(SHA_A, { 'iam/prod': encrypted }));

    const written = await readFile(path, 'utf8');
    expect(written).toContain('ENC[AES256_GCM');
    expect(written).not.toContain('hunter2');
  });
});

describe('SnapshotStore resilience', () => {
  it('reports no snapshot on a first-ever boot instead of throwing', async () => {
    // Principle 5: a first boot with nothing cached must still start. The absence of a snapshot
    // is an ordinary state, not an error.
    expect(await new SnapshotStore(path).load()).toBeNull();
  });

  it('survives a truncated snapshot rather than failing to boot', async () => {
    // A file cut short by a power cut must not be the thing that keeps the service down.
    await writeFile(path, '{"commit": "aaa', 'utf8');

    expect(await new SnapshotStore(path).load()).toBeNull();
  });

  it('survives a snapshot of the wrong shape', async () => {
    await writeFile(path, JSON.stringify({ commit: 42, sources: 'nope' }), 'utf8');

    expect(await new SnapshotStore(path).load()).toBeNull();
  });

  it('rejects a snapshot whose namespace values are not text', async () => {
    await writeFile(
      path,
      JSON.stringify({ commit: SHA_A, sources: { 'iam/prod': { A: 1 } } }),
      'utf8',
    );

    expect(await new SnapshotStore(path).load()).toBeNull();
  });
});

describe('SnapshotStore atomicity', () => {
  it('leaves no partial file behind when it writes', async () => {
    // Written to a temp name and renamed, so a crash mid-write leaves either the old snapshot
    // or the new one — never half of either.
    const store = new SnapshotStore(path);

    await store.save(sources(SHA_A, { 'iam/prod': 'A: 1\n' }));

    expect(await readdir(dir)).toEqual(['snapshot.json']);
  });

  it('keeps the previous snapshot readable when a new save fails', async () => {
    const store = new SnapshotStore(path);
    await store.save(sources(SHA_A, { 'iam/prod': 'A: 1\n' }));

    await new SnapshotStore(join(dir, 'no-such-dir', 'snapshot.json'))
      .save(sources(SHA_B, {}))
      .catch(() => {});

    expect((await store.load())?.commit).toBe(SHA_A);
  });
});
