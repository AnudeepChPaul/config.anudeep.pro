import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { logCaught } from '@config/src/logging.js';
import type { PeerCredentials } from './types.js';

/**
 * Peer identity, taken from the kernel.
 *
 * The credential is not transmitted, so there is nothing to leak in a log, a span attribute or
 * a pasted `curl`, and nothing to replay. The client sends no identity claim at all — the value
 * here comes from `getsockopt` on the accepted socket.
 *
 * Node exposes neither `SO_PEERCRED` nor `getpeereid`, so the syscall lives behind a reader that
 * the resolver is given. That keeps the resolver's rules testable without a kernel, and keeps
 * the FFI in one place.
 */

export type PeerCredentialReader = (socket: Socket) => PeerCredentials;

export class PeerCredentialError extends Error {}

export class PeerCredentialResolver {
  constructor(private readonly read: PeerCredentialReader) {}

  resolve(socket: Socket): PeerCredentials {
    if (socket.destroyed) {
      // The fd is gone. Whatever the kernel now says about it does not describe the peer that
      // sent this request.
      throw new PeerCredentialError('cannot read peer credentials: socket is destroyed');
    }

    let creds: PeerCredentials;
    try {
      creds = this.read(socket);
    } catch (cause) {
      logCaught(cause, 'config.peercred.read.failed', { logger: 'identity.peercred' });
      throw new PeerCredentialError('could not read peer credentials from the socket', { cause });
    }

    // A partial or nonsensical credential must not flow onward: as a registry miss it would read
    // in the log as "unknown service" when the truth is "the mechanism is broken".
    for (const field of ['uid', 'gid', 'pid'] as const) {
      const value = creds[field];
      if (!Number.isInteger(value) || value < 0) {
        throw new PeerCredentialError(`peer credentials are invalid: ${field}=${String(value)}`);
      }
    }

    return { uid: creds.uid, gid: creds.gid, pid: creds.pid };
  }
}

/** The libc-level socket option numbers. Linux only; Darwin's `LOCAL_PEERCRED` differs in both. */
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
/** `struct ucred { pid_t pid; uid_t uid; gid_t gid; }` — three 32-bit fields. */
const UCRED_SIZE = 12;

interface SocketHandle {
  fd?: number;
}

function socketFd(socket: Socket): number {
  const fd = (socket as unknown as { _handle?: SocketHandle })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) {
    throw new Error('socket has no file descriptor');
  }
  return fd;
}

/**
 * The real reader, for the platform the service actually runs on.
 *
 * `koffi` rather than a native addon so the runtime image needs no compiler toolchain. Loaded
 * lazily and bound once, so importing this module on a developer's Mac costs nothing and fails
 * only if the reader is actually used.
 */
export function platformPeerCredentialReader(): PeerCredentialReader {
  if (process.platform !== 'linux') {
    throw new Error(
      `SO_PEERCRED peer identification is implemented for Linux only; this is ${process.platform}`,
    );
  }

  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
  const libc = koffi.load('libc.so.6');
  const getsockopt = libc.func(
    'int getsockopt(int fd, int level, int optname, _Out_ void *optval, _Inout_ int *optlen)',
  );

  return (socket: Socket): PeerCredentials => {
    const buffer = Buffer.alloc(UCRED_SIZE);
    const length = [UCRED_SIZE];
    const rc = getsockopt(socketFd(socket), SOL_SOCKET, SO_PEERCRED, buffer, length);
    if (rc !== 0) {
      throw new Error(`getsockopt(SO_PEERCRED) failed with ${rc}`);
    }
    return {
      pid: buffer.readInt32LE(0),
      uid: buffer.readInt32LE(4),
      gid: buffer.readInt32LE(8),
    };
  };
}
