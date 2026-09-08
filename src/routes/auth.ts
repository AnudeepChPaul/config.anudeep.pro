import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BreakGlass } from '../auth/break-glass.js';
import type { Session, SessionCodec } from '../auth/session.js';
import { renderLogin } from '../views/pages.js';

/**
 * Sign-in, sign-out, and the guard in front of everything else.
 *
 * Two ways in, and they are mutually exclusive by design: iam while iam answers, break-glass
 * only while it does not. The break-glass form is not even rendered when iam is up — showing a
 * form that will always refuse invites people to burn one-time codes against it.
 */

export const SESSION_COOKIE = 'config_session';

/** Short, because a stateless session cannot be revoked before it expires. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AuthOptions {
  readonly codec: SessionCodec;
  readonly breakGlass: BreakGlass;
  readonly isIamReachable: () => Promise<boolean>;
  /** Where iam sends the browser to start an OIDC login. */
  readonly iamLoginUrl?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthOptions,
  environment: string,
): void {
  const open = new Set(['/login', '/login/break-glass', '/logout', '/healthz']);

  // A guard that runs before every handler, rather than one each route opts into: the failure
  // mode of opt-in is a new route that silently has none.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = auth.codec.verify(request.cookies[SESSION_COOKIE] ?? '');
    if (session) request.session = session;
    if (session || open.has(request.url.split('?')[0] ?? '')) return;

    return reply.code(302).header('location', '/login').send();
  });

  app.get('/login', async (request, reply) => {
    if (request.session) return reply.code(302).header('location', '/').send();

    // Break-glass is offered only while iam is unreachable, so the page has to ask.
    const iamUp = await auth.isIamReachable();
    return reply
      .type('text/html; charset=utf-8')
      .send(
        String(renderLogin({ iamReachable: iamUp, iamLoginUrl: auth.iamLoginUrl ?? '/login/iam' })),
      );
  });

  app.post(
    '/login/break-glass',
    async (request: FastifyRequest<{ Body: Record<string, string> }>, reply) => {
      const body = request.body ?? {};
      const result = await auth.breakGlass.attempt(body.password ?? '', body.code ?? '');

      if (!result.ok) {
        // One message for every failure — a wrong password, a wrong code, a spent code, or iam
        // being up. Anything more specific is an oracle.
        return reply
          .code(401)
          .type('text/html; charset=utf-8')
          .send(
            String(
              renderLogin({
                iamReachable: await auth.isIamReachable(),
                iamLoginUrl: auth.iamLoginUrl ?? '/login/iam',
                error: result.error.detail,
              }),
            ),
          );
      }

      return reply
        .setCookie(
          SESSION_COOKIE,
          auth.codec.sign({
            email: result.value.email,
            id: result.value.id,
            via: 'break-glass',
            expiresAt: Date.now() + SESSION_TTL_MS,
          }),
          auth.codec.cookieOptions(environment),
        )
        .code(303)
        .header('location', '/')
        .send();
    },
  );

  app.post('/logout', async (_request, reply) =>
    reply
      .clearCookie(SESSION_COOKIE, auth.codec.cookieOptions(environment))
      .code(303)
      .header('location', '/login')
      .send(),
  );
}
