import { stat, unlink } from 'node:fs/promises';
import net from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { type InternalRouteOptions, registerInternalRoutes } from './routes/internal.js';

/**
 * The read API, bound to a Unix socket and nothing else.
 *
 * It binds no TCP port — not a loopback one either. That is the plan's central claim: an
 * attacker on the internet cannot send this endpoint a packet whatever credentials they hold,
 * because there is no address to send it to. Caddy has no route to it and it is not on the
 * Docker network.
 */

/** How long to wait for a connect attempt before calling a socket abandoned. */
const LIVENESS_TIMEOUT_MS = 1_000;

export class SocketInUseError extends Error {}

/**
 * Whether anything is actually accepting connections on `path`.
 *
 * A socket file outlives the process that bound it, so its presence says nothing about whether
 * an instance is running. Connecting is the only way to tell the two apart: a live listener
 * accepts, an abandoned inode refuses with ECONNREFUSED.
 */
function isSocketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const settle = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(LIVENESS_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/**
 * Clears the path if — and only if — what sits there is a socket nobody is serving.
 *
 * Three cases, and they need three different answers:
 *
 *  - **Nothing there.** Ordinary first start.
 *  - **An abandoned socket.** A container killed with SIGKILL never runs its cleanup. Refusing
 *    to start would leave every service on the host waiting for a human, so it is removed.
 *  - **A live socket, or a file that is not a socket.** Refuse. Unlinking a live instance's
 *    socket would not disturb its existing connections but would silently redirect every new
 *    one, leaving two processes serving the same config with nothing to show for it. And
 *    deleting whatever happens to sit at a configured path is how a typo in a compose file
 *    becomes data loss.
 */
async function clearAbandonedSocket(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch {
    return;
  }

  if (!stats.isSocket()) {
    throw new SocketInUseError(`${path} exists and is not a socket; refusing to remove it`);
  }

  if (await isSocketLive(path)) {
    throw new SocketInUseError(`${path} is already being served by another instance`);
  }

  await unlink(path);
}

export interface ReadApi {
  readonly server: FastifyInstance['server'];
  listen(socketPath: string): Promise<void>;
  close(): Promise<void>;
}

export interface ReadApiOptions extends InternalRouteOptions {
  readonly logger?: FastifyInstance['log'] | false;
}

export async function buildReadApi(options: ReadApiOptions): Promise<ReadApi> {
  const app = Fastify({ logger: options.logger ?? false });
  registerInternalRoutes(app, options);
  await app.ready();

  let listeningOn: string | null = null;

  return {
    server: app.server,

    async listen(socketPath: string): Promise<void> {
      await clearAbandonedSocket(socketPath);
      await app.listen({ path: socketPath });
      listeningOn = socketPath;
    },

    async close(): Promise<void> {
      await app.close();
      // Node does not unlink the socket on close, so without this every restart would be an
      // unclean one from the next process's point of view.
      if (listeningOn) await unlink(listeningOn).catch(() => {});
      listeningOn = null;
    },
  };
}
