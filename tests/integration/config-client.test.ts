import { existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadApi } from '@config/src/app.js';
import { ConfigClient } from '@config/src/client/config-client.js';
import { AccessGuard } from '@config/src/identity/access-guard.js';
import {
  PeerCredentialResolver,
  platformPeerCredentialReader,
} from '@config/src/identity/peercred.js';
import { ServiceRegistry } from '@config/src/identity/registry.js';
import { ConfigCache } from '@config/src/store/cache.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The client every consuming service imports.
 *
 * Its whole job is to make configuration a non-dependency. A service must start when config is
 * down, when config has never been reachable, and when its own cache is corrupt — because the
 * alternative is that one 4 GB box's config service becomes a single point of failure for
 * every service on the platform, including the one you would use to fix it.
 *
 * Linux only: the transport is a Unix socket authenticated by SO_PEERCRED.
 */

const linuxOnly = process.platform === 'linux' ? describe : describe.skip;
const uid = () => process.getuid?.() ?? -1;

interface Defaults extends Record<string, unknown> {
  MFA_ENFORCEMENT: string;
  SESSION_TTL: number;
}

const DEFAULTS: Defaults = { MFA_ENFORCEMENT: 'optional', SESSION_TTL: 3600 };

linuxOnly('ConfigClient', () => {
  let dir: string;
  let socketPath: string;
  let cachePath: string;
  let api: Awaited<ReturnType<typeof buildReadApi>> | null = null;
  let raw: net.Server | null = null;

  /** A real config service granting this test process the iam/prod namespace. */
  const startServer = async (
    namespaces: Record<string, Record<string, unknown>>,
    commit = 'a'.repeat(40),
  ) => {
    const cache = new ConfigCache();
    cache.reload({ commit, namespaces: new Map(Object.entries(namespaces)) });
    api = await buildReadApi({
      cache,
      guard: new AccessGuard({
        resolver: new PeerCredentialResolver(platformPeerCredentialReader()),
        registry: ServiceRegistry.fromYaml(
          `services:\n  - name: iam\n    uid: ${uid()}\n    namespaces: [iam/prod]\n`,
        ),
        audit: vi.fn(),
        alert: vi.fn(),
      }),
      onRead: () => {},
    });
    await api.listen(socketPath);
  };

  const client = (overrides: Partial<ConstructorParameters<typeof ConfigClient>[0]> = {}) =>
    new ConfigClient<Defaults>({
      socketPath,
      service: 'iam',
      environment: 'prod',
      cachePath,
      fetchTimeoutMs: 5_000,
      ...overrides,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-client-'));
    socketPath = join(dir, 'config.sock');
    cachePath = join(dir, 'last-known-good.json');
  });

  afterEach(async () => {
    await api?.close();
    api = null;
    raw?.close();
    raw = null;
    await rm(dir, { recursive: true, force: true });
  });

  describe('never blocking boot', () => {
    it('starts with defaults when the socket does not exist', async () => {
      // A first-ever boot on a host where config has not been deployed yet.
      const config = await client().load(DEFAULTS);

      expect(config).toEqual(DEFAULTS);
    });

    it('does not wait for a config service that accepts but never answers', async () => {
      // The failure that a timeout alone does not cover: the socket is there, the connection is
      // accepted, and no response ever comes. A synchronous fetch here would hang boot for the
      // whole timeout — and this is exactly the state an overloaded box is in.
      raw = net.createServer(() => {});
      await new Promise<void>((resolve) => raw?.listen(socketPath, resolve));

      const started = Date.now();
      const config = await client({ fetchTimeoutMs: 30_000 }).load(DEFAULTS);

      expect(Date.now() - started).toBeLessThan(500);
      expect(config).toEqual(DEFAULTS);
    });

    it('does not throw when the config service refuses the namespace', async () => {
      // A grant that has not been added yet must degrade to defaults, not crash the caller.
      const cache = new ConfigCache();
      cache.reload({ commit: 'b'.repeat(40), namespaces: new Map() });
      api = await buildReadApi({
        cache,
        guard: new AccessGuard({
          resolver: new PeerCredentialResolver(platformPeerCredentialReader()),
          registry: ServiceRegistry.fromYaml(
            'services:\n  - name: other\n    uid: 65500\n    namespaces: [other/prod]\n',
          ),
          audit: vi.fn(),
          alert: vi.fn(),
        }),
        onRead: () => {},
      });
      await api.listen(socketPath);

      await expect(client().load(DEFAULTS)).resolves.toEqual(DEFAULTS);
    });

    it('does not throw when the namespace has no file', async () => {
      await startServer({});

      await expect(client().load(DEFAULTS)).resolves.toEqual(DEFAULTS);
    });
  });

  describe('overriding defaults', () => {
    it('takes the served value over the compiled-in default', async () => {
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client();
      await c.load(DEFAULTS);

      await c.refresh();

      expect(c.current().MFA_ENFORCEMENT).toBe('all');
    });

    it('keeps the default for a key the registry does not override', async () => {
      // The registry is an override channel, not the origin. A namespace that mentions one key
      // must not blank out the rest.
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client();
      await c.load(DEFAULTS);

      await c.refresh();

      expect(c.current().SESSION_TTL).toBe(3600);
    });

    it('exposes the commit it is serving values from', async () => {
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } }, 'c'.repeat(40));
      const c = client();
      await c.load(DEFAULTS);

      await c.refresh();

      expect(c.commit()).toBe('c'.repeat(40));
    });
  });

  describe('last-known-good on disk', () => {
    it('writes what it fetched', async () => {
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client();
      await c.load(DEFAULTS);

      await c.refresh();

      expect(existsSync(cachePath)).toBe(true);
    });

    it('is readable only by the service that owns it', async () => {
      // The cache holds values the server decrypted, so on this side they are plaintext. It
      // must not be readable by other uids sharing the host.
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client();
      await c.load(DEFAULTS);
      await c.refresh();

      expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    });

    it('serves the last-known-good when config is unreachable at the next boot', async () => {
      // The point of the file. An incident that takes config down must not silently revert
      // every service to its compiled-in defaults, undoing the overrides set during the last
      // incident.
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const first = client();
      await first.load(DEFAULTS);
      await first.refresh();
      await api?.close();
      api = null;

      const config = await client().load(DEFAULTS);

      expect(config.MFA_ENFORCEMENT).toBe('all');
    });

    it('falls back to defaults when the cache file is corrupt', async () => {
      // A truncated cache must not be the thing that stops a service from starting.
      writeFileSync(cachePath, '{"config": ');

      await expect(client().load(DEFAULTS)).resolves.toEqual(DEFAULTS);
    });

    it('ignores a cache written for a different namespace', async () => {
      // A cache path reused by two services through a copy-pasted compose file would otherwise
      // feed one service the other's configuration.
      writeFileSync(
        cachePath,
        JSON.stringify({
          service: 'api',
          environment: 'prod',
          commit: 'd'.repeat(40),
          config: { MFA_ENFORCEMENT: 'all' },
        }),
      );

      await expect(client().load(DEFAULTS)).resolves.toEqual(DEFAULTS);
    });

    it('works with no cache path configured at all', async () => {
      // Opting out is legitimate: a service holding only non-secret flags may prefer defaults
      // over a stale file.
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client({ cachePath: undefined });

      await c.load(DEFAULTS);
      await c.refresh();

      expect(c.current().MFA_ENFORCEMENT).toBe('all');
      expect(existsSync(cachePath)).toBe(false);
    });
  });

  describe('invalidation', () => {
    it('notifies when a refresh brings a different commit', async () => {
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client();
      const onChange = vi.fn();
      c.onInvalidate(onChange);
      await c.load(DEFAULTS);
      await c.refresh();
      onChange.mockClear();

      await api?.close();
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'admins' } }, 'e'.repeat(40));
      await c.refresh();

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(c.current().MFA_ENFORCEMENT).toBe('admins');
    });

    it('stays quiet when nothing moved', async () => {
      // Handlers rebuild caches and reopen pools. Firing them on every poll would make the 60s
      // fallback poll an every-60s disruption.
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client();
      const onChange = vi.fn();
      c.onInvalidate(onChange);
      await c.load(DEFAULTS);
      await c.refresh();
      onChange.mockClear();

      await c.refresh();

      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not let one handler throwing stop the others', async () => {
      await startServer({ 'iam/prod': { MFA_ENFORCEMENT: 'all' } });
      const c = client();
      const second = vi.fn();
      c.onInvalidate(() => {
        throw new Error('handler exploded');
      });
      c.onInvalidate(second);
      await c.load(DEFAULTS);

      await expect(c.refresh()).resolves.not.toThrow();
      expect(second).toHaveBeenCalled();
    });
  });
});
