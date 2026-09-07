import { unlink } from 'node:fs/promises';
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
      // A container killed with SIGKILL leaves the socket file behind and bind() then fails
      // with EADDRINUSE. Refusing to start after an unclean shutdown would make every service
      // on the host wait for a human, so a stale file is removed first.
      //
      // This is safe because only one process is meant to own this path: if another instance
      // were genuinely live, removing the file would not disturb its existing connections, and
      // the compose file gives each deployment its own socket.
      await unlink(socketPath).catch(() => {});
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
