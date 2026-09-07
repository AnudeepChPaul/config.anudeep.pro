import type { Socket } from 'node:net';
import { PeerCredentialResolver } from '@config/src/identity/peercred.js';
import { describe, expect, it } from 'vitest';

/**
 * The resolver's contract, independent of the syscall behind it.
 *
 * `SO_PEERCRED` (Linux) and `LOCAL_PEERCRED`/`getpeereid` (Darwin) are not reachable from Node's
 * standard library, so the resolver takes a platform reader. These tests fix what the resolver
 * does with what the reader returns; `tests/integration/peercred-socket.test.ts` fixes that the
 * Linux reader returns the truth.
 */

const fakeSocket = () => ({ destroyed: false }) as unknown as Socket;

describe('PeerCredentialResolver', () => {
  it('returns the kernel-reported credentials of the peer', () => {
    const resolver = new PeerCredentialResolver(() => ({ uid: 1002, gid: 1002, pid: 4711 }));

    expect(resolver.resolve(fakeSocket())).toEqual({ uid: 1002, gid: 1002, pid: 4711 });
  });

  it('throws rather than returning a partial credential when the syscall fails', () => {
    // A resolver that returned `{ uid: undefined }` here would flow into the registry as a
    // lookup miss, which reads in the log as "unknown service" instead of "the mechanism is
    // broken". Those need different responses.
    const resolver = new PeerCredentialResolver(() => {
      throw new Error('ENOTSOCK');
    });

    expect(() => resolver.resolve(fakeSocket())).toThrow(/peer credentials/i);
  });

  it('throws when the socket is already destroyed, before consulting the kernel', () => {
    // The fd is gone; whatever the syscall reports about it cannot be trusted to describe the
    // peer that sent this request.
    let consulted = false;
    const resolver = new PeerCredentialResolver(() => {
      consulted = true;
      return { uid: 1002, gid: 1002, pid: 4711 };
    });
    const destroyed = { destroyed: true } as unknown as Socket;

    expect(() => resolver.resolve(destroyed)).toThrow(/destroyed/i);
    expect(consulted).toBe(false);
  });

  it('rejects a negative uid, which no kernel reports and no grant can match', () => {
    const resolver = new PeerCredentialResolver(() => ({ uid: -1, gid: -1, pid: 0 }));

    expect(() => resolver.resolve(fakeSocket())).toThrow(/peer credentials/i);
  });
});
