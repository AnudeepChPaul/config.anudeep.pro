import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PeerCredentialResolver,
  platformPeerCredentialReader,
} from '@config/src/identity/peercred.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The claim the whole auth mechanism rests on: the uid the resolver reports comes from the
 * kernel and is not something the client sent. Asserting it against a real socket is the only
 * way to test that — a stubbed reader would be testing the stub.
 *
 * Only Linux `SO_PEERCRED` is in scope for production (the service runs in Docker); the suite
 * skips elsewhere rather than pretending to cover it.
 */

const linuxOnly = process.platform === 'linux' ? describe : describe.skip;

linuxOnly('SO_PEERCRED over a real Unix socket', () => {
  let dir: string;
  let sockPath: string;
  const servers: net.Server[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-peercred-'));
    sockPath = join(dir, 'config.sock');
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports this process own uid, gid and pid for a local connection', async () => {
    const resolver = new PeerCredentialResolver(platformPeerCredentialReader());

    const seen = new Promise<{ uid: number; gid: number; pid: number }>((resolve, reject) => {
      const server = net.createServer((socket) => {
        try {
          resolve(resolver.resolve(socket));
        } catch (err) {
          reject(err);
        } finally {
          socket.destroy();
        }
      });
      servers.push(server);
      server.listen(sockPath);
    });

    const client = net.connect(sockPath);
    const creds = await seen;
    client.destroy();

    expect(creds.uid).toBe(process.getuid?.());
    expect(creds.gid).toBe(process.getgid?.());
    expect(creds.pid).toBe(process.pid);
  });

  it('ignores any uid the client asserts in the payload', async () => {
    // The transport carries no identity claim at all. This test exists so that a future change
    // adding a header-based fallback fails here rather than in production.
    const resolver = new PeerCredentialResolver(platformPeerCredentialReader());

    const seen = new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.once('data', () => {
          try {
            resolve(resolver.resolve(socket).uid);
          } catch (err) {
            reject(err);
          } finally {
            socket.destroy();
          }
        });
      });
      servers.push(server);
      server.listen(sockPath + '.2');
    });

    const client = net.connect(sockPath + '.2');
    client.write(JSON.stringify({ uid: 0, service: 'iam' }));
    const uid = await seen;
    client.destroy();

    expect(uid).toBe(process.getuid?.());
    expect(uid).not.toBe(0);
  });
});
