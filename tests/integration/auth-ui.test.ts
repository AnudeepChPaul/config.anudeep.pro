import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { decodeBase32 } from '@config/src/auth/base32.js';
import { BreakGlass, hashPassword } from '@config/src/auth/break-glass.js';
import { OidcClient } from '@config/src/auth/oidc.js';
import { SessionCodec } from '@config/src/auth/session.js';
import { generateTotp, totpCounter } from '@config/src/auth/totp.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import type { WriteEvent } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, liveOptions, TestRepo } from '../helpers.js';

/**
 * Authentication in front of the editor.
 *
 * Until this, every save was attributed to `unauthenticated@localhost` and anyone who could
 * reach the port could change MFA enforcement. These tests are about the two things that
 * changes: nothing is reachable without a session, and the commit trailer names a real person.
 */

const withSops = hasSops() ? describe : describe.skip;

const SECRET = 'x'.repeat(64);
const SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const BREAK_GLASS_PASSWORD = 'correct horse battery staple';

const SCHEMA = `version: 1
keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
`;

withSops('the editor behind authentication', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let git: GitRepository;
  let app: Awaited<ReturnType<typeof buildWebApp>>;
  let iamReachable: boolean;
  let alert: ReturnType<typeof vi.fn>;
  let issuer: FastifyInstance;
  let issuerUrl: string;

  let written: WriteEvent[] = [];
  let live: Awaited<ReturnType<typeof liveOptions>>;
  const etagForProd = async () => (await live.db.etag('config/iam/prod.yaml')) ?? '';

  const codec = new SessionCodec(SECRET);

  const start = async (withOidc = true) => {
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    alert = vi.fn();
    written = [];
    live = await liveOptions(repo.dir, { iam: SCHEMA }, loader, (event) => written.push(event));
    app = await buildWebApp({
      ...live,
      environment: 'dev',
      auth: {
        codec,
        breakGlass: new BreakGlass({
          record: {
            passwordHash: await hashPassword(BREAK_GLASS_PASSWORD),
            totpSecret: SECRET_BASE32,
            actorEmail: 'breakglass@anudeep.pro',
          },
          isIamReachable: async () => iamReachable,
          alert: alert as unknown as (a: { outcome: string; at: number }) => void,
        }),
        isIamReachable: async () => iamReachable,
        // A stub issuer that would happily complete the exchange. That is the point: if the
        // callback's guard were removed, these requests would succeed rather than fail for an
        // unrelated reason, so the tests below distinguish "refused by the guard" from
        // "refused because iam was unreachable".
        oidc: withOidc
          ? new OidcClient({
              issuer: issuerUrl,
              clientId: 'config',
              clientSecret: 'shh',
              redirectUri: 'http://localhost/login/callback',
            })
          : undefined,
      },
    });
    return app;
  };

  const currentCode = () =>
    generateTotp(decodeBase32(SECRET_BASE32), {
      counter: totpCounter(Math.floor(Date.now() / 1000)),
      digits: 6,
    });

  const signedInCookie = (via: 'iam' | 'break-glass' = 'iam') =>
    `config_session=${codec.sign({
      email: 'me@anudeep.pro',
      id: '7f3a1c9e',
      via,
      expiresAt: Date.now() + 3_600_000,
    })}`;

  const get = (url: string, cookie?: string) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  const post = (url: string, fields: Record<string, string>, cookie?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
    });

  /** Answers discovery and the token exchange the way iam would, for a valid flow. */
  const startIssuer = async () => {
    issuer = Fastify({ logger: false });
    await issuer.register(formbody);
    const probe = await issuer.listen({ host: '127.0.0.1', port: 0 });
    await issuer.close();
    issuerUrl = probe;

    issuer = Fastify({ logger: false });
    await issuer.register(formbody);
    issuer.get('/.well-known/openid-configuration', async () => ({
      issuer: issuerUrl,
      authorization_endpoint: `${issuerUrl}/authorize`,
      token_endpoint: `${issuerUrl}/token`,
    }));
    issuer.post('/token', async () => {
      const part = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
      return {
        access_token: 'at',
        token_type: 'Bearer',
        id_token: `${part({ alg: 'none' })}.${part({
          iss: issuerUrl,
          aud: 'config',
          sub: '7f3a1c9e',
          email: 'me@anudeep.pro',
          nonce: 'the-nonce',
          exp: Math.floor(Date.now() / 1000) + 300,
        })}.`,
      };
    });
    await issuer.listen({ host: '127.0.0.1', port: Number(new URL(issuerUrl).port) });
  };

  beforeEach(async () => {
    iamReachable = true;
    await startIssuer();
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'services.yaml':
        'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
      'environments.yaml': 'order: [dev, prod]\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key.recipient}\n`,
    });
    git = new GitRepository(repo.dir);
    await start();
  });

  afterEach(async () => {
    await app?.close();
    await issuer?.close();
    await rm(repo.dir, { recursive: true, force: true });
  });

  describe('refusing anonymous access', () => {
    it('sends an unauthenticated visitor to the sign-in page', async () => {
      const response = await get('/');

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login');
    });

    it('refuses an unauthenticated namespace view', async () => {
      expect((await get('/p/iam?env=prod')).statusCode).toBe(302);
    });

    it('refuses an unauthenticated save without applying it', async () => {
      const before = await git.headCommit();

      const response = await post('/p/iam/prod', { 'key.MFA_ENFORCEMENT': 'all' });

      expect(response.statusCode).toBe(302);
      expect(await git.headCommit()).toBe(before);
    });

    it('refuses a session cookie that was tampered with', async () => {
      const forged = `config_session=${Buffer.from(
        JSON.stringify({
          email: 'attacker@example.com',
          id: 'x',
          via: 'iam',
          expiresAt: Date.now() + 1000,
        }),
      ).toString('base64url')}.nosignature`;

      expect((await get('/', forged)).statusCode).toBe(302);
    });

    it('lets an authenticated visitor in', async () => {
      expect((await get('/', signedInCookie())).statusCode).toBe(200);
    });

    it('serves the sign-in page without a session', async () => {
      expect((await get('/login')).statusCode).toBe(200);
    });
  });

  describe('the sign-in page', () => {
    it('offers iam while iam is reachable', async () => {
      const body = (await get('/login')).body;

      expect(body).toMatch(/sign in with iam/i);
    });

    it('does not offer break-glass while iam is reachable', async () => {
      // Showing a form that will always refuse invites people to burn codes against it.
      expect((await get('/login')).body).not.toMatch(/authenticator code/i);
    });

    it('offers break-glass once iam is unreachable', async () => {
      iamReachable = false;

      const body = (await get('/login')).body;

      expect(body).toMatch(/authenticator code/i);
      expect(body).toMatch(/alert/i);
    });
  });

  describe('break-glass sign-in', () => {
    it('signs in with the right password and code while iam is down', async () => {
      iamReachable = false;

      const response = await post('/login/break-glass', {
        password: BREAK_GLASS_PASSWORD,
        code: currentCode(),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers['set-cookie']).toBeTruthy();
      expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    });

    it('refuses while iam is reachable, whatever is submitted', async () => {
      const response = await post('/login/break-glass', {
        password: BREAK_GLASS_PASSWORD,
        code: currentCode(),
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('gives the same message for a wrong password as for a wrong code', async () => {
      iamReachable = false;

      const wrongPassword = await post('/login/break-glass', {
        password: 'no',
        code: currentCode(),
      });
      const wrongCode = await post('/login/break-glass', {
        password: BREAK_GLASS_PASSWORD,
        code: '000000',
      });

      expect(wrongPassword.body).toBe(wrongCode.body);
    });

    it('alerts on every attempt', async () => {
      iamReachable = false;

      await post('/login/break-glass', { password: 'no', code: '000000' });

      expect(alert).toHaveBeenCalled();
    });
  });

  describe('attribution', () => {
    // Attribution is recorded with the write and carried to the commit the sync engine writes
    // when it next backs up, rather than being written by the edit itself. So these assert what
    // the write recorded; tests/unit/sync-engine.test.ts owns the message it becomes.
    it('records the signed-in person, not an anonymous placeholder', async () => {
      // The reason this slice exists. Before it, every entry in the audit trail said
      // `unauthenticated@localhost`, which records that a change happened and nothing else.
      await post(
        '/p/iam/prod',
        { 'key.MFA_ENFORCEMENT': 'all', etag: await etagForProd() },
        signedInCookie(),
      );

      expect(written.map((event) => event.actor).join(' ')).toContain('me@anudeep.pro');
      expect(written.map((event) => event.actor).join(' ')).not.toContain('unauthenticated');
    });

    it('records which credential was used', async () => {
      // A change made under break-glass was made while the identity provider was down and
      // nobody could be checked against it. That belongs in the record.
      await post(
        '/p/iam/prod',
        { 'key.MFA_ENFORCEMENT': 'all', etag: await etagForProd() },
        signedInCookie('break-glass'),
      );

      expect(written.map((event) => event.actor).join(' ')).toContain('break-glass');
    });
  });

  describe('the iam callback', () => {
    // A full OIDC exchange is covered in oidc.test.ts against a real issuer. These cases are
    // about the callback route's own guard: what it accepts before it ever calls iam.
    const flowCookie = (overrides: Record<string, unknown> = {}) =>
      `config_login=${codec.signValue({
        state: 'the-state',
        nonce: 'the-nonce',
        verifier: 'v'.repeat(43),
        expiresAt: Date.now() + 600_000,
        ...overrides,
      })}`;

    it('sends a challenge derived from the verifier it stored', async () => {
      // These two are minted together and must agree. Deriving the challenge from a fresh
      // verifier looks correct, redirects correctly, and then iam refuses every exchange —
      // a failure that only shows up against a real issuer. I wrote exactly that bug.
      const response = await get('/login/iam');
      const challenge = new URL(String(response.headers.location)).searchParams.get(
        'code_challenge',
      );
      const cookie = String(response.headers['set-cookie']).match(/config_login=([^;]+)/)?.[1];
      const flow = codec.verifyValue<{ verifier: string }>(decodeURIComponent(cookie ?? ''));

      expect(flow).not.toBeNull();
      expect(challenge).toBe(
        createHash('sha256')
          .update(flow?.verifier ?? '')
          .digest('base64url'),
      );
    });

    it('completes a sign-in when the flow matches', async () => {
      // The control for every case below: with a valid flow this callback really does sign in,
      // so a rejection in the other cases is the guard doing its job and not iam being absent.
      const response = await get('/login/callback?code=abc&state=the-state', flowCookie());

      expect(response.statusCode).toBe(303);
      expect(String(response.headers['set-cookie'])).toContain('config_session=');
    });

    it('refuses a callback with no flow cookie', async () => {
      // Nothing started this sign-in in this browser, which is what CSRF on the callback is.
      const response = await get('/login/callback?code=abc&state=the-state');

      expect(response.statusCode).toBe(400);
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain('config_session=');
    });

    it('refuses a callback whose state does not match the flow', async () => {
      const response = await get('/login/callback?code=abc&state=someone-elses', flowCookie());

      expect(response.statusCode).toBe(400);
    });

    it('refuses a callback for a flow that has expired', async () => {
      const response = await get(
        '/login/callback?code=abc&state=the-state',
        flowCookie({ expiresAt: Date.now() - 1 }),
      );

      expect(response.statusCode).toBe(400);
    });

    it('refuses a flow cookie that was edited', async () => {
      const forged = `config_login=${Buffer.from(
        JSON.stringify({ state: 'mine', nonce: 'n', verifier: 'v', expiresAt: Date.now() + 1000 }),
      ).toString('base64url')}.nope`;

      expect((await get('/login/callback?code=abc&state=mine', forged)).statusCode).toBe(400);
    });

    it('refuses a callback carrying no code', async () => {
      expect((await get('/login/callback?state=the-state', flowCookie())).statusCode).toBe(400);
    });

    it('is not reachable when iam sign-in is not configured', async () => {
      // An instance with no OIDC client must not pretend the route is a sign-in.
      await app.close();
      await start(false);

      expect((await get('/login/iam')).statusCode).toBe(404);
    });

    it('says so on the sign-in page rather than offering a dead link', async () => {
      await app.close();
      await start(false);

      expect((await get('/login')).body).toMatch(/not configured/i);
    });
  });

  describe('signing out', () => {
    it('clears the cookie', async () => {
      const response = await post('/logout', {}, signedInCookie());

      expect(response.statusCode).toBe(303);
      expect(String(response.headers['set-cookie'])).toMatch(/config_session=;|Max-Age=0/);
    });
  });
});
