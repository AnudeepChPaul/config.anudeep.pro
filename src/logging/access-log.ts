/**
 * One row per request, whatever the outcome.
 *
 * Emitted in `onResponse`, including 404s and refused credentials. A failure here must never
 * affect the response it is describing.
 */

import type { LogDbSink } from '@config/src/logging/db-sink.js';
import { currentUserEmail, emit, logCaught, logRefused } from '@config/src/logging.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function pathOf(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}

export function attachAccessLog(app: FastifyInstance, sink: LogDbSink): void {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const bytes = Number(reply.getHeader('content-length'));
      const status = reply.statusCode;
      sink.pushAccess({
        occurredAt: new Date(),
        method: request.method,
        ...(request.routeOptions?.url ? { route: request.routeOptions.url } : {}),
        path: pathOf(request.url),
        statusCode: status,
        durationMs: reply.elapsedTime,
        ...(Number.isFinite(bytes) ? { responseBytes: bytes } : {}),
        ...(currentUserEmail() ? { userEmail: currentUserEmail() as string } : {}),
        ...(request.session?.id ? { userId: request.session.id } : {}),
        requestId: String(request.id),
      });
      if (status >= 400) {
        const fields = {
          logger: 'http',
          method: request.method,
          path: pathOf(request.url),
          status,
        };
        if (status >= 500) emit(undefined, 'error', fields, 'config.request.failed');
        else logRefused('config.request.failed', fields);
      }
    } catch (error) {
      logCaught(error, 'config.access-log.failed', { logger: 'logging.access' });
    }
  });
}
