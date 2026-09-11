/**
 * Silences Fastify's own per-request lines, keeping its error lines.
 *
 * `incoming request` and `request completed` duplicate `log.access_log` and fire before ALS is
 * bound, so they would lack request_sid. Fastify 5 deprecates disableRequestLogging.
 */
import { LogController } from 'fastify';

export class QuietRequestLogging extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(
    error: Error | null | undefined,
    _request: Parameters<LogController['requestCompleted']>[1],
    reply: Parameters<LogController['requestCompleted']>[2],
  ): void {
    if (!error) return;
    reply.log.error({ err: error, responseTime: reply.elapsedTime }, 'request errored');
  }
}
