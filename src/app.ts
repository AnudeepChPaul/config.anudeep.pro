import { readFileSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { type AuthOptions, registerAuthRoutes } from './routes/auth.js';
import { type InternalRouteOptions, registerInternalRoutes } from './routes/internal.js';
import { registerUiRoutes, type UiRouteOptions } from './routes/ui.js';
import { registerWebhookRoutes, type WebhookOptions } from './routes/webhook.js';

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
  /** Overrides how long a current caller is held open. Tests use a short one. */
  /** A pino instance. Fastify 5 takes an existing logger as `loggerInstance`, not `logger`. */
  readonly logger?: FastifyInstance['log'];
}

export async function buildReadApi(options: ReadApiOptions): Promise<ReadApi> {
  const app = Fastify(options.logger ? { loggerInstance: options.logger } : { logger: false });
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

export interface WebAppOptions extends UiRouteOptions {
  readonly environment: string;
  /**
   * Sign-in and the guard. Absent means the editor runs open, which prod refuses.
   *
   * Its presence *is* the authentication, rather than a separate boolean saying so — a flag and
   * a guard can disagree, and the way they disagree is that the flag says protected.
   */
  readonly auth?: AuthOptions;
  /** Passed to the cookie: secure unless this says otherwise. Never set in prod. */
  readonly insecureCookie?: boolean;
  readonly logger?: FastifyInstance['log'];
}

export class UnprotectedUiError extends Error {}

/**
 * The CRUD UI, over HTTP.
 *
 * Unlike the read API this one is reachable from a browser, so it refuses to start in prod
 * without authentication in front of it. These routes can close registration and change MFA
 * enforcement for the whole platform; running them unprotected because a login was not wired up
 * yet is not a state worth leaving reachable, and a warning in a log is not a control.
 */
export async function buildWebApp(options: WebAppOptions): Promise<FastifyInstance> {
  // Every environment, not only prod. These routes can close registration, change MFA
  // enforcement and publish commits for the whole platform; serving them unguarded because an
  // environment string said `dev` is not a state worth being able to reach by accident, and
  // "which environment is this" is exactly the question that went wrong.
  if (!options.auth) {
    throw new UnprotectedUiError('refusing to serve the configuration UI without authentication');
  }

  const app = Fastify(options.logger ? { loggerInstance: options.logger } : { logger: false });
  await app.register(cookie);
  await app.register(formbody);
  registerAssetRoutes(app);
  // Before the UI routes, so its onRequest guard runs ahead of every handler they add.
  if (options.auth) registerAuthRoutes(app, options.auth, options.insecureCookie ?? false);
  registerUiRoutes(app, options);
  await app.ready();
  return app;
}

/**
 * The webhook listener.
 *
 * Its own server, on its own port, because it is the one thing here that faces the internet.
 * Sharing a server with the editor would mean one routing mistake exposes the editor, and one
 * middleware ordering mistake puts a session guard in front of GitHub.
 */
export async function buildWebhookApp(
  options: WebhookOptions & { logger?: FastifyInstance['log'] },
): Promise<FastifyInstance> {
  const app = Fastify(options.logger ? { loggerInstance: options.logger } : { logger: false });
  registerWebhookRoutes(app, options);
  await app.ready();
  return app;
}

/**
 * The one static asset this service serves: htmx, from its own origin.
 *
 * Read once at boot and held in memory — it is 50KB and never changes without a deploy. Serving
 * it ourselves rather than from a CDN matters more here than usual: this editor is reached
 * *during* an incident, and a page that cannot render because someone else's network is down
 * is exactly the wrong failure.
 */
function registerAssetRoutes(app: FastifyInstance): void {
  const require = createRequire(import.meta.url);
  const script = readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');
  // Our own, beside it: the tick behaviour a server render cannot express.
  const ticks = readFileSync(new URL('./views/assets/ticks.js', import.meta.url).pathname, 'utf8');

  app.get('/assets/htmx.js', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      // Immutable for a year: the path changes when the dependency does, because the file is
      // resolved from node_modules at boot.
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(script),
  );

  app.get('/assets/ticks.js', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      // Ours changes with a deploy, so it is revalidated rather than held for a year.
      .header('cache-control', 'no-cache')
      .send(ticks),
  );
}
