import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logCaught } from '@config/src/logging.js';

/**
 * The GitHub push webhook — the only route on this service the public internet can reach.
 *
 * Everything else is behind a session or on a Unix socket. This is a URL anyone can post to, so
 * the signature is the whole of its access control.
 */

const SIGNATURE_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';

/** Only pushes to the branch that is actually served. A PR branch is not the configuration. */
const SERVED_REF = 'refs/heads/main';

export interface WebhookOptions {
  /** Null means unconfigured, which closes the route rather than opening it. */
  readonly secret: string | null;
  readonly onPush: () => Promise<void>;
  readonly onError?: (error: Error) => void;
}

/**
 * Verifies the signature over the bytes that actually arrived.
 *
 * Not over a re-serialisation of the parsed body: `JSON.stringify(request.body)` reorders keys,
 * drops whitespace, and changes number formatting, so it would reject genuine deliveries and —
 * worse — could accept a tampered one whose re-serialisation happens to match.
 */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const given = Buffer.from(header, 'utf8');
  const want = Buffer.from(expected, 'utf8');

  return given.length === want.length && timingSafeEqual(given, want);
}

export function registerWebhookRoutes(app: FastifyInstance, options: WebhookOptions): void {
  // The raw body is kept because the signature covers it. Fastify's JSON parser would otherwise
  // hand over a parsed object and the original bytes would be gone.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  app.post('/webhooks/github', async (request: FastifyRequest, reply) => {
    if (!options.secret) {
      // Reachable from the internet, so an unset secret must close the door. Failing open here
      // is failing open to everyone.
      return reply.code(503).send({ code: 'not_configured' });
    }

    const raw = request.body as Buffer;
    const signature = request.headers[SIGNATURE_HEADER];
    if (
      !verifySignature(raw, typeof signature === 'string' ? signature : undefined, options.secret)
    ) {
      return reply.code(401).send({ code: 'bad_signature' });
    }

    if (request.headers[EVENT_HEADER] !== 'push') {
      // A ping arrives when the hook is created; anything but a 2xx makes GitHub show the hook
      // as broken.
      return reply.code(204).send();
    }

    let payload: { ref?: unknown };
    try {
      payload = JSON.parse(raw.toString('utf8')) as { ref?: unknown };
    } catch (error) {
      logCaught(error, 'config.webhook.payload.failed', { logger: 'webhook' });
      return reply.code(400).send({ code: 'bad_payload' });
    }

    if (payload.ref !== SERVED_REF) return reply.code(204).send();

    // Answer first, pull after. GitHub gives ten seconds and then retries, so a slow pull would
    // turn one push into a queue of duplicate deliveries.
    void options.onPush().catch((error: Error) => {
      logCaught(error, 'config.webhook.push.failed', { logger: 'webhook' });
      options.onError?.(error);
    });

    return reply.code(202).send();
  });
}
