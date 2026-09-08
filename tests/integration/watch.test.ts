import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
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
 * Telling services a change landed.
 *
 * The plan had config POST an invalidate to each service. That needs config to hold an address
 * for every consumer — configuration about the consumers of configuration — and an inbound
 * endpoint on each of them. Inverting it removes both: the client holds a request open on the
 * socket it already uses, and config answers when the commit moves.
 *
 * Linux only: the transport is the SO_PEERCRED socket.
 */

const linuxOnly = process.platform === 'linux' ? describe : describe.skip;
const uid = () => process.getuid?.() ?? -1;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

linuxOnly('waiting for a change', () => {
  let dir: string;
  let socketPath: string;
  let cache: ConfigCache;
  let api: Awaited<ReturnType<typeof buildReadApi>> | null = null;

  const start = async () => {
    cache = new ConfigCache();
    cache.reload({ commit: SHA_A, namespaces: new Map([['iam/prod', { A: 1 }]]) });
    api = await buildReadApi({
      cache,
      guard: new AccessGuard({
        resolver: new PeerCredentialResolver(platformPeerCredentialReader()),
        registry: () =>
          ServiceRegistry.fromYaml(
            `services:\n  - name: iam\n    uid: ${uid()}\n    namespaces: [iam/prod]\n`,
          ),
        audit: vi.fn(),
        alert: vi.fn(),
      }),
      onRead: () => {},
      waitTimeoutMs: 400,
    });
    await api.listen(socketPath);
  };

  const get = (path: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = http.request({ socketPath, path, method: 'GET' }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on('error', reject);
      request.end();
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-watch-'));
    socketPath = join(dir, 'config.sock');
    await start();
  });

  afterEach(async () => {
    await api?.close();
    api = null;
    await rm(dir, { recursive: true, force: true });
  });

  describe('the read API', () => {
    it('answers at once when the caller is behind', async () => {
      // Nothing to wait for: the caller asked about a commit that is already history.
      const response = await get(`/config/iam/prod?since=${SHA_B}`);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).commit).toBe(SHA_A);
    });

    it('holds the request open while the caller is current', async () => {
      const started = Date.now();

      const response = await get(`/config/iam/prod?since=${SHA_A}`);

      // It waited rather than answering immediately, then gave up and said "no change".
      expect(Date.now() - started).toBeGreaterThan(300);
      expect(response.status).toBe(304);
    });

    it('answers the moment a change lands', async () => {
      // The point of the whole mechanism: propagation is immediate, not on the next poll.
      const started = Date.now();
      const pending = get(`/config/iam/prod?since=${SHA_A}`);
      setTimeout(
        () => cache.reload({ commit: SHA_B, namespaces: new Map([['iam/prod', { A: 2 }]]) }),
        60,
      );

      const response = await pending;

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).config).toEqual({ A: 2 });
      expect(Date.now() - started).toBeLessThan(350);
    });

    it('still refuses a namespace the caller may not read', async () => {
      // Waiting must not be a way around the grant table.
      const response = await get(`/config/audit/prod?since=${SHA_A}`);

      expect(response.status).toBe(403);
    });

    it('is unaffected when no since is given', async () => {
      const response = await get('/config/iam/prod');

      expect(response.status).toBe(200);
    });
  });

  describe('ConfigClient.watch', () => {
    it('picks up a change without being asked to refresh', async () => {
      const client = new ConfigClient<{ A: number }>({
        socketPath,
        service: 'iam',
        environment: 'prod',
        fetchTimeoutMs: 2_000,
      });
      await client.load({ A: 0 });
      await client.refresh();
      const changed = vi.fn();
      client.onInvalidate(changed);

      const stop = client.watch();
      cache.reload({ commit: SHA_B, namespaces: new Map([['iam/prod', { A: 2 }]]) });
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3_000 });
      stop();

      expect(client.current().A).toBe(2);
    });

    it('stops when told to', async () => {
      // A watch that outlives its owner keeps a connection open against a socket that may be
      // gone, and reconnects forever.
      const client = new ConfigClient<{ A: number }>({
        socketPath,
        service: 'iam',
        environment: 'prod',
        fetchTimeoutMs: 2_000,
      });
      await client.load({ A: 0 });

      const stop = client.watch();
      stop();

      expect(client.watching()).toBe(false);
    });

    it('survives the config service going away and coming back', async () => {
      // An outage must not end the watch — otherwise every service needs a restart after config
      // is redeployed, which is the opposite of what this is for.
      const client = new ConfigClient<{ A: number }>({
        socketPath,
        service: 'iam',
        environment: 'prod',
        fetchTimeoutMs: 500,
        retryDelayMs: 50,
      });
      await client.load({ A: 0 });
      const stop = client.watch();

      await api?.close();
      api = null;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await start();

      const changed = vi.fn();
      client.onInvalidate(changed);
      cache.reload({ commit: SHA_B, namespaces: new Map([['iam/prod', { A: 3 }]]) });

      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
      stop();
      expect(client.current().A).toBe(3);
    });
  });
});
