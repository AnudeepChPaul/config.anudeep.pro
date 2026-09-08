import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BreakGlass } from '../auth/break-glass.js';
import { createPkce, type OidcClient, pkceFor } from '../auth/oidc.js';
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
/** Carries state, nonce and the PKCE verifier between the redirect and the callback. */
export const FLOW_COOKIE = 'config_login';

/** Short, because a stateless session cannot be revoked before it expires. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AuthOptions {
  readonly codec: SessionCodec;
  readonly breakGlass: BreakGlass;
  readonly isIamReachable: () => Promise<boolean>;
  /** Absent when iam OIDC is not configured; the sign-in page then offers nothing but waiting. */
  readonly oidc?: OidcClient;
}

interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

/** Long enough to sign in, short enough that an abandoned flow cannot be resumed later. */
const FLOW_TTL_MS = 10 * 60 * 1000;

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
  const open = new Set([
    '/login',
    '/login/iam',
    '/login/callback',
    '/login/break-glass',
    '/logout',
    '/healthz',
    // The sign-in page needs the script too, and a redirect served as JavaScript is a
    // confusing failure to debug.
    '/assets/htmx.js',
  ]);

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
    return reply.type('text/html; charset=utf-8').send(
      String(
        renderLogin({
          iamReachable: iamUp,
          iamConfigured: Boolean(auth.oidc),
          iamLoginUrl: '/login/iam',
        }),
      ),
    );
  });

  app.get('/login/iam', async (_request, reply) => {
    if (!auth.oidc) return reply.code(404).send();

    // State, nonce and verifier are minted here and kept in a signed cookie rather than in
    // process memory: a server-side map would be one more thing to expire and to lose on a
    // restart, in the middle of someone signing in.
    const flow: FlowState = {
      state: randomBytes(16).toString('base64url'),
      nonce: randomBytes(16).toString('base64url'),
      verifier: createPkce().verifier,
      expiresAt: Date.now() + FLOW_TTL_MS,
    };

    const url = await auth.oidc.authorizationUrl({
      state: flow.state,
      nonce: flow.nonce,
      // Derived from the verifier just stored. A fresh pair here would send a challenge that
      // verifier does not satisfy, and iam would refuse every exchange.
      pkce: pkceFor(flow.verifier),
    });

    return reply
      .setCookie(FLOW_COOKIE, auth.codec.signValue(flow), {
        ...auth.codec.cookieOptions(environment),
        maxAge: FLOW_TTL_MS / 1000,
      })
      .code(302)
      .header('location', url)
      .send();
  });

  app.get(
    '/login/callback',
    async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
      if (!auth.oidc) return reply.code(404).send();

      const flow = auth.codec.verifyValue<FlowState>(request.cookies[FLOW_COOKIE] ?? '');
      const query = request.query ?? {};

      // No cookie, a stale flow, or a state that does not match means this callback did not
      // come from a sign-in this browser started — which is what CSRF on the callback is.
      if (!flow || flow.expiresAt <= Date.now() || !query.state || query.state !== flow.state) {
        return signInFailed(reply, 'This sign-in link has expired. Start again.');
      }

      if (!query.code) return signInFailed(reply, 'iam did not return an authorization code.');

      let claims: { sub: string; email: string };
      try {
        claims = await auth.oidc.exchange({
          code: query.code,
          verifier: flow.verifier,
          nonce: flow.nonce,
        });
      } catch {
        // Deliberately not the underlying reason: it would distinguish a wrong audience from an
        // expired token for anyone who can reach this endpoint.
        return signInFailed(reply, 'iam could not complete this sign-in.');
      }

      return reply
        .clearCookie(FLOW_COOKIE, auth.codec.cookieOptions(environment))
        .setCookie(
          SESSION_COOKIE,
          auth.codec.sign({
            email: claims.email,
            id: claims.sub,
            via: 'iam',
            expiresAt: Date.now() + SESSION_TTL_MS,
          }),
          auth.codec.cookieOptions(environment),
        )
        .code(303)
        .header('location', '/')
        .send();
    },
  );

  async function signInFailed(reply: FastifyReply, detail: string) {
    return reply
      .code(400)
      .type('text/html; charset=utf-8')
      .send(
        String(
          renderLogin({
            iamReachable: await auth.isIamReachable(),
            iamConfigured: Boolean(auth.oidc),
            iamLoginUrl: '/login/iam',
            error: detail,
          }),
        ),
      );
  }

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
                iamConfigured: Boolean(auth.oidc),
                iamLoginUrl: '/login/iam',
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
