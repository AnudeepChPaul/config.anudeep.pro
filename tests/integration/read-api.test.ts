import { existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadApi } from '@config/src/app.js';
import { type AccessAuditEntry, AccessGuard } from '@config/src/identity/access-guard.js';
import {
  PeerCredentialResolver,
  platformPeerCredentialReader,
} from '@config/src/identity/peercred.js';
import { ServiceRegistry } from '@config/src/identity/registry.js';
import type { ReadLogEntry } from '@config/src/routes/internal.js';
import { ConfigCache } from '@config/src/store/cache.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The read API, over a real Unix socket, authenticated by the real kernel.
 *
 * Every earlier identity test proved a piece in isolation. This is the first time a request
 * actually arrives over a socket, has its uid read by `getsockopt`, is matched against the grant
 * table and is answered — so it is the first test that would catch the pieces being wired
 * together wrongly.
 *
 * Linux only: `SO_PEERCRED` does not exist on darwin. See Dockerfile.test.
 */

const linuxOnly = process.platform === 'linux' ? describe : describe.skip;

const SHA = 'a'.repeat(40);
const uid = () => process.getuid?.() ?? -1;

/** A grant table naming this test process as `service`, so the kernel reports a granted uid. */
const registryFor = (service: string, namespaces: string[]) =>
  ServiceRegistry.fromYaml(
    `services:\n  - name: ${service}\n    uid: ${uid()}\n    namespaces: [${namespaces.join(', ')}]\n`,
  );

/** A GET over the Unix socket. No host, no port — there is nothing to address but the path. */
function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

linuxOnly('read API over a Unix socket', () => {
  let dir: string;
  let socketPath: string;
  let app: Awaited<ReturnType<typeof buildReadApi>> | null = null;
  let audit: ReturnType<typeof vi.fn>;
  let alert: ReturnType<typeof vi.fn>;
  let reads: ReadLogEntry[];

  const cacheWith = (namespaces: Record<string, Record<string, unknown>>) => {
    const cache = new ConfigCache();
    cache.reload({ commit: SHA, namespaces: new Map(Object.entries(namespaces)) });
    return cache;
  };

  /** Boots the API on a socket, with this process granted the given namespaces. */
  const start = async (options: {
    service?: string;
    grants?: string[];
    namespaces?: Record<string, Record<string, unknown>>;
  }) => {
    audit = vi.fn();
    alert = vi.fn();
    reads = [];
    app = await buildReadApi({
      cache: cacheWith(options.namespaces ?? { 'iam/prod': { MFA_ENFORCEMENT: 'all' } }),
      guard: new AccessGuard({
        resolver: new PeerCredentialResolver(platformPeerCredentialReader()),
        registry: registryFor(options.service ?? 'iam', options.grants ?? ['iam/prod']),
        audit: audit as unknown as (e: AccessAuditEntry) => void,
        alert: alert as unknown as (e: AccessAuditEntry) => void,
      }),
      onRead: (entry) => reads.push(entry),
    });
    await app.listen(socketPath);
    return app;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-api-'));
    socketPath = join(dir, 'config.sock');
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    await rm(dir, { recursive: true, force: true });
  });

  describe('serving config', () => {
    it('answers a granted service with its namespace', async () => {
      await start({});

      const { status, body } = await get(socketPath, '/config/iam/prod');

      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({
        service: 'iam',
        environment: 'prod',
        commit: SHA,
        config: { MFA_ENFORCEMENT: 'all' },
      });
    });

    it('reports the commit it is serving, so a client can tell whether anything moved', async () => {
      await start({});

      expect(JSON.parse((await get(socketPath, '/config/iam/prod')).body).commit).toBe(SHA);
    });

    it('serves an empty config for a namespace that overrides nothing', async () => {
      await start({ namespaces: { 'iam/prod': {} } });

      const { status, body } = await get(socketPath, '/config/iam/prod');

      expect(status).toBe(200);
      expect(JSON.parse(body).config).toEqual({});
    });

    it('returns 404 when a granted namespace has no file', async () => {
      // The caller is allowed to know this namespace's state, so the honest answer is that it
      // does not exist — distinct from the 403 an ungranted caller gets.
      await start({ namespaces: {} });

      expect((await get(socketPath, '/config/iam/prod')).status).toBe(404);
    });
  });

  describe('authorisation', () => {
    it('denies a service reading another service namespace', async () => {
      await start({ service: 'api', grants: ['api/prod'] });

      expect((await get(socketPath, '/config/iam/prod')).status).toBe(403);
    });

    it('denies a uid that holds no grant at all', async () => {
      const registry = ServiceRegistry.fromYaml(
        'services:\n  - name: iam\n    uid: 65500\n    namespaces: [iam/prod]\n',
      );
      audit = vi.fn();
      alert = vi.fn();
      reads = [];
      app = await buildReadApi({
        cache: cacheWith({ 'iam/prod': { A: 1 } }),
        guard: new AccessGuard({
          resolver: new PeerCredentialResolver(platformPeerCredentialReader()),
          registry,
          audit: audit as unknown as (e: AccessAuditEntry) => void,
          alert: alert as unknown as (e: AccessAuditEntry) => void,
        }),
        onRead: (entry) => reads.push(entry),
      });
      await app.listen(socketPath);

      expect((await get(socketPath, '/config/iam/prod')).status).toBe(403);
    });

    it('tells a denied caller nothing about why', async () => {
      // An ungranted namespace and an unknown uid must be indistinguishable from outside, or
      // the endpoint becomes an oracle for which services and namespaces exist.
      await start({ service: 'api', grants: ['api/prod'] });

      const { body } = await get(socketPath, '/config/iam/prod');

      expect(body).not.toMatch(/uid|namespace|grant|api/i);
    });

    it('does not reveal whether an ungranted namespace exists', async () => {
      // 404 for a missing one and 403 for a forbidden one would let a caller map the whole
      // repository by walking names.
      await start({ service: 'api', grants: ['api/prod'], namespaces: {} });

      expect((await get(socketPath, '/config/iam/prod')).status).toBe(403);
    });

    it('checks the grant before touching the cache', async () => {
      await start({ service: 'api', grants: ['api/prod'] });

      await get(socketPath, '/config/iam/prod');

      expect(reads).toEqual([]);
    });
  });

  describe('read-access logging', () => {
    it('records who read which namespace, and at which commit', async () => {
      await start({});

      await get(socketPath, '/config/iam/prod');

      expect(reads).toEqual([
        expect.objectContaining({
          service: 'iam',
          uid: uid(),
          namespace: 'iam/prod',
          commit: SHA,
          outcome: 'served',
        }),
      ]);
    });

    it('logs the key names that were read', async () => {
      // "Who read this key" is the question the log has to answer after a secret is rotated.
      await start({
        namespaces: { 'iam/prod': { MFA_ENFORCEMENT: 'all', SMTP_PASSWORD: 'hunter2' } },
      });

      await get(socketPath, '/config/iam/prod');

      expect(reads[0]?.keys.sort()).toEqual(['MFA_ENFORCEMENT', 'SMTP_PASSWORD']);
    });

    it('never puts a config value in the read log', async () => {
      // The log is the one place a decrypted secret could escape the process without anyone
      // noticing, because logs are shipped, indexed and retained far longer than a response is.
      await start({ namespaces: { 'iam/prod': { SMTP_PASSWORD: 'hunter2' } } });

      await get(socketPath, '/config/iam/prod');

      expect(JSON.stringify(reads)).not.toContain('hunter2');
    });

    it('audits the authorisation decision as well as the read', async () => {
      await start({});

      await get(socketPath, '/config/iam/prod');

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'allowed', service: 'iam', namespace: 'iam/prod' }),
      );
    });
  });

  describe('the socket itself', () => {
    it('listens on a path and binds no TCP port', async () => {
      // The plan's central claim: an attacker on the internet cannot send this endpoint a
      // packet, whatever credentials they hold. A returned address object with a port would
      // mean it was listening on the network after all.
      await start({});

      expect(app?.server.address()).toBe(socketPath);
    });

    it('creates the socket file where it was told to', async () => {
      await start({});

      expect(existsSync(socketPath)).toBe(true);
      expect(statSync(socketPath).isSocket()).toBe(true);
    });

    it('starts even though a stale socket file is already at the path', async () => {
      // A container killed with SIGKILL never runs its cleanup, so the inode stays and bind()
      // fails with EADDRINUSE. Refusing to start after an unclean shutdown would make every
      // service on the host wait for a human. Simulated here by leaving a file at the path,
      // since a clean close removes the real one.
      writeFileSync(socketPath, '');
      expect(existsSync(socketPath)).toBe(true);

      await expect(start({})).resolves.toBeTruthy();

      expect((await get(socketPath, '/config/iam/prod')).status).toBe(200);
    });

    it('removes the socket file when it shuts down cleanly', async () => {
      await start({});
      await app?.close();
      app = null;

      expect(existsSync(socketPath)).toBe(false);
    });
  });
});
