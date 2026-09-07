import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessGuard } from '../identity/access-guard.js';
import type { ConfigCache } from '../store/cache.js';

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
  readonly onRead: (entry: ReadLogEntry) => void;
}

interface ConfigParams {
  service: string;
  environment: string;
}

export function registerInternalRoutes(app: FastifyInstance, options: InternalRouteOptions): void {
  const { cache, guard, onRead } = options;

  app.get(
    '/config/:service/:environment',
    async (request: FastifyRequest<{ Params: ConfigParams }>, reply) => {
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
      const config = cache.get(service, environment);

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

      return reply.send({ service, environment, commit: cache.commit(), config });
    },
  );
}
