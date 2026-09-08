import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { decodeBase32 } from '@config/src/auth/base32.js';
import { BreakGlass, hashPassword } from '@config/src/auth/break-glass.js';
import { SessionCodec } from '@config/src/auth/session.js';
import { generateTotp, totpCounter } from '@config/src/auth/totp.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, TestRepo } from '../helpers.js';

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

const SCHEMA = `keys:
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

  const codec = new SessionCodec(SECRET);

  const start = async () => {
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    alert = vi.fn();
    app = await buildWebApp({
      repository: git,
      loader,
      schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
      writeService: new ConfigWriteService({
        repository: git,
        loader,
        encryptor: new SopsEncryptor(repo.dir),
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
      }),
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

  beforeEach(async () => {
    iamReachable = true;
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key.recipient}\n`,
    });
    git = new GitRepository(repo.dir);
    await start();
  });

  afterEach(async () => {
    await app?.close();
    await rm(repo.dir, { recursive: true, force: true });
  });

  describe('refusing anonymous access', () => {
    it('sends an unauthenticated visitor to the sign-in page', async () => {
      const response = await get('/');

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login');
    });

    it('refuses an unauthenticated namespace view', async () => {
      expect((await get('/ns/iam/prod')).statusCode).toBe(302);
    });

    it('refuses an unauthenticated save without applying it', async () => {
      const before = await git.headCommit();

      const response = await post('/ns/iam/prod', {
        baseCommit: before,
        message: 'sneak',
        'key.MFA_ENFORCEMENT': 'all',
      });

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
    it('commits as the signed-in person, not as an anonymous placeholder', async () => {
      // The reason this slice exists. Before it, every commit in the audit trail said
      // `unauthenticated@localhost`, which records that a change happened and nothing else.
      await post(
        '/ns/iam/prod',
        {
          baseCommit: await git.headCommit(),
          message: 'tighten MFA',
          'key.MFA_ENFORCEMENT': 'all',
        },
        signedInCookie(),
      );

      const body = await repo.git('log', '-1', '--format=%B');
      expect(body).toContain('Actor: me@anudeep.pro');
      expect(body).not.toContain('unauthenticated');
    });

    it('records which credential was used', async () => {
      // A change made under break-glass was made while the identity provider was down and
      // nobody could be checked against it. That belongs in the record.
      await post(
        '/ns/iam/prod',
        { baseCommit: await git.headCommit(), message: 'emergency', 'key.MFA_ENFORCEMENT': 'all' },
        signedInCookie('break-glass'),
      );

      expect(await repo.git('log', '-1', '--format=%B')).toContain('Signed-In-With: break-glass');
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
