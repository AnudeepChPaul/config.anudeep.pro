import { createHash } from 'node:crypto';
import { createPkce, OidcClient, OidcError } from '@config/src/auth/oidc.js';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The iam sign-in exchange, against a real issuer over a real socket.
 *
 * A mocked `fetch` would let every assertion here pass while the request shape was wrong — the
 * form encoding, the parameter names, the basic-auth header. The stub issuer below answers only
 * what a real one answers, and rejects what a real one rejects.
 */

const ISSUER_CLAIMS = {
  sub: '7f3a1c9e',
  email: 'me@anudeep.pro',
};

interface StubOptions {
  /** Overrides merged into the id_token claims, to build a token that should be refused. */
  claims?: Record<string, unknown>;
  failToken?: boolean;
}

/** An unsigned JWT. The exchange is a direct TLS back-channel call, so the payload is what matters. */
const jwt = (claims: Record<string, unknown>): string => {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`;
};

describe('OidcClient', () => {
  let issuer: FastifyInstance;
  let issuerUrl: string;
  let received: Record<string, string> = {};
  let options: StubOptions = {};

  const startIssuer = async () => {
    issuer = Fastify({ logger: false });
    await issuer.register(formbody);

    issuer.get('/.well-known/openid-configuration', async () => ({
      issuer: issuerUrl,
      authorization_endpoint: `${issuerUrl}/authorize`,
      token_endpoint: `${issuerUrl}/token`,
    }));

    issuer.post('/token', async (request, reply) => {
      received = request.body as Record<string, string>;
      if (options.failToken) return reply.code(400).send({ error: 'invalid_grant' });

      return {
        access_token: 'at',
        token_type: 'Bearer',
        id_token: jwt({
          iss: issuerUrl,
          aud: 'config',
          sub: ISSUER_CLAIMS.sub,
          email: ISSUER_CLAIMS.email,
          nonce: 'test-nonce',
          exp: Math.floor(Date.now() / 1000) + 300,
          ...options.claims,
        }),
      };
    });

    const address = await issuer.listen({ host: '127.0.0.1', port: 0 });
    issuerUrl = address;
    return address;
  };

  const client = () =>
    new OidcClient({
      issuer: issuerUrl,
      clientId: 'config',
      clientSecret: 'shh',
      redirectUri: 'https://config.anudeep.pro/login/callback',
    });

  beforeEach(async () => {
    options = {};
    received = {};
    issuer = Fastify({ logger: false });
    // The discovery document must name the issuer's own URL, which is only known after listen.
    const probe = await issuer.listen({ host: '127.0.0.1', port: 0 });
    await issuer.close();
    issuerUrl = probe;
    await startIssuer();
  });

  afterEach(async () => {
    await issuer.close();
  });

  describe('the authorization redirect', () => {
    it('sends the browser to the issuer with the parameters iam needs', async () => {
      const pkce = createPkce();

      const url = new URL(await client().authorizationUrl({ state: 's', nonce: 'n', pkce }));

      expect(url.origin + url.pathname).toBe(`${issuerUrl}/authorize`);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('config');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://config.anudeep.pro/login/callback',
      );
      expect(url.searchParams.get('state')).toBe('s');
      expect(url.searchParams.get('nonce')).toBe('n');
    });

    it('asks for the claims it actually reads, and no more', async () => {
      const url = new URL(
        await client().authorizationUrl({ state: 's', nonce: 'n', pkce: createPkce() }),
      );

      expect(url.searchParams.get('scope')).toBe('openid email');
    });

    it('sends the PKCE challenge, hashed', async () => {
      // Sending the verifier itself would make PKCE decorative: anyone who intercepted the
      // redirect would hold everything needed to redeem the code.
      const pkce = createPkce();

      const url = new URL(await client().authorizationUrl({ state: 's', nonce: 'n', pkce }));

      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
      expect(url.searchParams.get('code_challenge')).not.toBe(pkce.verifier);
    });
  });

  describe('createPkce', () => {
    it('derives the challenge as the SHA-256 of the verifier', () => {
      const pkce = createPkce();

      expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    });

    it('produces a different verifier every time', () => {
      expect(createPkce().verifier).not.toBe(createPkce().verifier);
    });

    it('produces a verifier long enough to be unguessable', () => {
      // RFC 7636 sets a 43-character floor; below it the challenge is brute-forceable.
      expect(createPkce().verifier.length).toBeGreaterThanOrEqual(43);
    });
  });

  describe('the code exchange', () => {
    it('returns the claims iam asserted', async () => {
      const claims = await client().exchange({
        code: 'abc',
        verifier: 'v'.repeat(43),
        nonce: 'test-nonce',
      });

      expect(claims.email).toBe('me@anudeep.pro');
      expect(claims.sub).toBe('7f3a1c9e');
    });

    it('sends the PKCE verifier, so a stolen code alone is not enough', async () => {
      await client().exchange({ code: 'abc', verifier: 'v'.repeat(43), nonce: 'test-nonce' });

      expect(received.code_verifier).toBe('v'.repeat(43));
      expect(received.grant_type).toBe('authorization_code');
      expect(received.code).toBe('abc');
    });

    it('fails when the issuer rejects the code', async () => {
      options.failToken = true;

      await expect(
        client().exchange({ code: 'bad', verifier: 'v'.repeat(43), nonce: 'test-nonce' }),
      ).rejects.toThrow(OidcError);
    });
  });

  describe('claims the exchange must refuse', () => {
    const reject = async (claims: Record<string, unknown>) => {
      options.claims = claims;
      return expect(
        client().exchange({ code: 'abc', verifier: 'v'.repeat(43), nonce: 'test-nonce' }),
      ).rejects.toThrow(OidcError);
    };

    it('refuses a token issued by someone else', async () => {
      // Otherwise any issuer this service can reach can mint a session here.
      await reject({ iss: 'https://evil.example.com' });
    });

    it('refuses a token meant for a different client', async () => {
      // An id_token for another relying party is a valid token that says nothing about us.
      await reject({ aud: 'some-other-app' });
    });

    it('refuses an expired token', async () => {
      await reject({ exp: Math.floor(Date.now() / 1000) - 1 });
    });

    it('refuses a token whose nonce does not match this login attempt', async () => {
      // The nonce is what ties the token to the browser that started the flow; without it a
      // token captured from another session could be replayed into this one.
      await reject({ nonce: 'someone-elses-nonce' });
    });

    it('refuses a token with no email, since the audit trail needs one', async () => {
      await reject({ email: undefined });
    });

    it('refuses a token with no subject', async () => {
      await reject({ sub: undefined });
    });
  });
});
