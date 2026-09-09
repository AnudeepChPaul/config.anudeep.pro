import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessGuard } from '../identity/access-guard.js';
import type { ConfigCache } from '../store/cache.js';
import { configOnly } from '../store/metadata.js';

/**
 * The read API every service calls.
 *
 * There is exactly one route and it is only reachable over the Unix socket. Authorisation runs
 * before the cache is consulted, so a caller that is not granted a namespace cannot learn
 * whether it exists.
 */

export interface ReadLogEntry {
  readonly outcome: 'served' | 'absent';
  readonly uid: number;
  readonly service: string;
  readonly namespace: string;
  readonly commit: string | null;
  /** Key *names* only. A value here would be a decrypted secret in a shipped, retained log. */
  readonly keys: string[];
}

export interface InternalRouteOptions {
  readonly cache: ConfigCache;
  readonly guard: AccessGuard;
  /**
   * Whether this product is being retired.
   *
   * A consuming service never reads a schema — it reads values over this socket — so a flag in
   * schema/<service>.yaml is invisible to the one process that most needs to see it. The server
   * carries it across in the same response as the values: a client that looks will find it, and
   * a client that does not is unaffected.
   *
   * Absent means nothing is retiring, which is the right default for a server that has not been
   * told otherwise.
   */
  readonly isRetiring?: (service: string) => boolean;
  readonly onRead: (entry: ReadLogEntry) => void;
  /** How long a caller that is already current is held before being told "no change". */
  readonly waitTimeoutMs?: number;
}

interface ConfigParams {
  service: string;
  environment: string;
}

interface ConfigQuery {
  /** The commit the caller already has. Present means "hold until this stops being current". */
  since?: string;
}

/** Long enough to be worth holding, short enough to survive any proxy or idle timeout. */
const DEFAULT_WAIT_MS = 25_000;

/**
 * Resolves when the cache moves past `since`, or when the timeout expires.
 *
 * This is the whole of the invalidate fan-out. The plan had config POST to each service, which
 * would mean config holding an address for every consumer and every consumer exposing an
 * inbound endpoint. Inverting it needs neither: the caller holds a request open on the socket
 * it already uses, and the answer arrives when the commit changes.
 */
function waitForChange(cache: ConfigCache, since: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };

    const unsubscribe = cache.onChange(() => {
      if (cache.commit() !== since) finish();
    });
    const timer = setTimeout(finish, timeoutMs);

    // The commit may already have moved between the caller's read and this subscription.
    if (cache.commit() !== since) finish();
  });
}

export function registerInternalRoutes(app: FastifyInstance, options: InternalRouteOptions): void {
  const { cache, guard, onRead } = options;
  const isRetiring = options.isRetiring ?? (() => false);

  app.get(
    '/config/:service/:environment',
    async (request: FastifyRequest<{ Params: ConfigParams; Querystring: ConfigQuery }>, reply) => {
      const { service, environment } = request.params;
      const namespace = `${service}/${environment}`;

      // `request.raw.socket` is the accepted connection. The uid comes off it from the kernel;
      // nothing in the request itself is trusted, and there is no header to forge.
      const authorised = guard.authorize(request.raw.socket, namespace);
      if (!authorised.ok) {
        const { status, ...problem } = authorised.error;
        return reply.code(status).send(problem);
      }

      const identity = authorised.value;

      // Authorisation first, then waiting: holding a request open must not become a way around
      // the grant table, nor a way to learn that a namespace exists.
      const since = request.query?.since;
      if (since && since === cache.commit()) {
        await waitForChange(cache, since, options.waitTimeoutMs ?? DEFAULT_WAIT_MS);
        if (cache.commit() === since) {
          // Nothing moved. The caller reconnects; a held-open request that never ends would be
          // indistinguishable from a hung service.
          return reply.code(304).send();
        }
      }

      // Metadata the file carries about itself — its sops block and its revision counter — is
      // not configuration. A service has no default for it and no use for it, and the counter
      // moves on every save, so serving it would invalidate a consumer's cache for a change to
      // nothing it reads.
      const stored = cache.get(service, environment);
      const config = stored === null ? null : configOnly(stored);

      if (config === null) {
        // The caller is granted this namespace, so it is entitled to know the namespace has no
        // file. An ungranted caller never reaches here — it was refused above with a 403.
        onRead({
          outcome: 'absent',
          uid: identity.uid,
          service: identity.name,
          namespace,
          commit: cache.commit(),
          keys: [],
        });
        return reply.code(404).send({ code: 'not_found', title: 'Not Found' });
      }

      onRead({
        outcome: 'served',
        uid: identity.uid,
        service: identity.name,
        namespace,
        commit: cache.commit(),
        keys: Object.keys(config),
      });

      // Always present, never omitted: an absent field reads as "this server is too old to tell
      // you", which is a different fact from "this product is staying".
      return reply.send({
        service,
        environment,
        commit: cache.commit(),
        retiring: isRetiring(service),
        config,
      });
    },
  );
}
