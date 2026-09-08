import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { BreakGlass } from '@config/src/auth/break-glass.js';
import { SessionCodec } from '@config/src/auth/session.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, TestRepo } from '../helpers.js';

/**
 * The CRUD UI.
 *
 * Two things dominate: nothing attacker-influenced may reach the page unescaped, and a secret
 * must never be rendered at all. The editor is used during incidents by someone who is about to
 * change how authentication behaves, so a value that can run script in that session is as good
 * as a compromise of iam.
 */

const withSops = hasSops() ? describe : describe.skip;

const SCHEMA = `keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
  SMTP_PASSWORD:
    type: string
    secret: true
`;

withSops('the CRUD UI', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let git: GitRepository;
  let app: Awaited<ReturnType<typeof buildWebApp>>;

  const start = async (options: { environment?: string; authenticated?: boolean } = {}) => {
    // `auth` present IS authentication; these cases only care whether prod refuses to run
    // without it, so a minimal stand-in is enough to say "something is in front".
    const auth = options.authenticated
      ? ({
          codec: new SessionCodec('y'.repeat(64)),
          breakGlass: new BreakGlass({
            record: null,
            isIamReachable: async () => true,
            alert: () => {},
          }),
          isIamReachable: async () => true,
        } as const)
      : undefined;
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
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
      environment: options.environment ?? 'dev',
      auth,
    });
    return app;
  };

  const get = (path: string) => app.inject({ method: 'GET', url: path });
  /**
   * A real urlencoded form post. The payload is encoded by hand because inject serialises an
   * object as JSON whatever the content-type says, which would exercise a body this app never
   * receives from a browser.
   */
  const post = (path: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: path,
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key.recipient}\n`,
    });
    git = new GitRepository(repo.dir);
  });

  afterEach(async () => {
    await app?.close();
    await rm(repo.dir, { recursive: true, force: true });
  });

  describe('refusing to run unprotected', () => {
    it('will not start in prod without authentication configured', async () => {
      // Slice 10 has not happened. Until it has, this page can change MFA enforcement and close
      // registration for anyone who can reach it, so the only safe prod behaviour is to refuse.
      await expect(start({ environment: 'prod', authenticated: false })).rejects.toThrow(
        /authentication/i,
      );
    });

    it('starts in prod once authentication is configured', async () => {
      await expect(start({ environment: 'prod', authenticated: true })).resolves.toBeTruthy();
    });

    it('starts in dev without it, for local work', async () => {
      await expect(start({ environment: 'dev' })).resolves.toBeTruthy();
    });
  });

  describe('listing', () => {
    it('shows every namespace in the repository', async () => {
      await start();

      const body = (await get('/')).body;

      expect(body).toContain('iam/prod');
    });

    it('shows the commit being served', async () => {
      await start();

      expect((await get('/')).body).toContain((await git.headCommit()).slice(0, 8));
    });
  });

  describe('viewing a namespace', () => {
    it('lists the keys and their values', async () => {
      await start();

      const body = (await get('/ns/iam/prod')).body;

      expect(body).toContain('MFA_ENFORCEMENT');
      expect(body).toContain('optional');
      expect(body).toContain('SESSION_TTL');
    });

    it('offers the schema enum values rather than a free text box', async () => {
      // Typing a value that the validator will reject is a round trip an operator does not need
      // during an incident.
      await start();

      const body = (await get('/ns/iam/prod')).body;

      expect(body).toContain('<select');
      // Every value the enum permits, so the operator picks rather than recalls.
      expect(body).toContain('optional');
      expect(body).toContain('admins');
      expect(body).toContain('all');
    });

    it('never renders a secret value', async () => {
      // The value is decrypted in this process, so it is available to render — which is exactly
      // why not rendering it has to be a deliberate rule. A shoulder, a screenshot in a ticket,
      // or a browser cache would otherwise leak it.
      await repo.commit({
        'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\n',
      });
      const result = await new ConfigWriteService({
        repository: git,
        loader: new ConfigLoader(new SopsDecryptor(key.secret)),
        encryptor: new SopsEncryptor(repo.dir),
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
      }).save(
        {
          service: 'iam',
          environment: 'prod',
          baseCommit: await git.headCommit(),
          changes: { SMTP_PASSWORD: 'hunter2' },
          message: 'set password',
        },
        { email: 'me@anudeep.pro', id: 'x' },
        { id: 'r', sourceIp: '::1' },
      );
      expect(result.ok).toBe(true);
      await start();

      const body = (await get('/ns/iam/prod')).body;

      expect(body).toContain('SMTP_PASSWORD');
      expect(body).not.toContain('hunter2');
    });

    it('says a secret is set without saying what it is', async () => {
      await start();

      expect((await get('/ns/iam/prod')).body).toMatch(/SMTP_PASSWORD/);
    });

    it('carries the current commit in the form, so a save can be checked for staleness', async () => {
      await start();

      const body = (await get('/ns/iam/prod')).body;

      expect(body).toContain(`value="${await git.headCommit()}"`);
    });

    it('returns 404 for a namespace that does not exist', async () => {
      await start();

      expect((await get('/ns/nope/prod')).statusCode).toBe(404);
    });
  });

  describe('escaping', () => {
    it('escapes a value that would otherwise close the element it sits in', async () => {
      // The config repo is writable through GitHub as well as through this UI, so a hostile
      // value can arrive without ever passing through this form's validation.
      await repo.commit({ 'config/evil/prod.yaml': "A: '</textarea><script>alert(1)</script>'\n" });
      await start();

      const body = (await get('/ns/evil/prod')).body;

      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).toContain('&lt;script&gt;');
    });

    it('escapes a hostile key name too', async () => {
      await repo.commit({ 'config/evil/prod.yaml': '"<img src=x onerror=alert(1)>": 1\n' });
      await start();

      expect((await get('/ns/evil/prod')).body).not.toContain('<img src=x');
    });
  });

  describe('saving', () => {
    it('applies a change and redirects back to the namespace', async () => {
      await start();

      const response = await post('/ns/iam/prod', {
        baseCommit: await git.headCommit(),
        message: 'tighten MFA',
        'key.MFA_ENFORCEMENT': 'all',
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/ns/iam/prod');
      expect((await get('/ns/iam/prod')).body).toContain('all');
    });

    it('shows validation errors instead of applying the change', async () => {
      await start();
      const before = await git.headCommit();

      const response = await post('/ns/iam/prod', {
        baseCommit: before,
        message: 'break it',
        'key.SESSION_TTL': '1',
      });

      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('SESSION_TTL');
      expect(await git.headCommit()).toBe(before);
    });

    it('reports a conflict when the page was loaded before someone else saved', async () => {
      await start();
      const stale = await git.headCommit();
      await post('/ns/iam/prod', {
        baseCommit: stale,
        message: 'first',
        'key.MFA_ENFORCEMENT': 'all',
      });

      const response = await post('/ns/iam/prod', {
        baseCommit: stale,
        message: 'second',
        'key.MFA_ENFORCEMENT': 'admins',
      });

      expect(response.statusCode).toBe(409);
      expect(response.body).toMatch(/reload|changed|conflict/i);
    });

    it('requires an audit message, since it becomes the commit subject', async () => {
      await start();

      const response = await post('/ns/iam/prod', {
        baseCommit: await git.headCommit(),
        message: '',
        'key.MFA_ENFORCEMENT': 'all',
      });

      expect(response.statusCode).toBe(422);
    });

    it('leaves a stored secret alone when its field is submitted blank', async () => {
      // The form never shows the current secret, so a blank field means "unchanged". Treating
      // it as a deletion would wipe the SMTP password every time someone edited an unrelated
      // flag on the same page — silently, and only noticed when mail stopped sending.
      await start();
      const writeService = new ConfigWriteService({
        repository: git,
        loader: new ConfigLoader(new SopsDecryptor(key.secret)),
        encryptor: new SopsEncryptor(repo.dir),
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
      });
      await writeService.save(
        {
          service: 'iam',
          environment: 'prod',
          baseCommit: await git.headCommit(),
          changes: { SMTP_PASSWORD: 'hunter2' },
          message: 'set password',
        },
        { email: 'me@anudeep.pro', id: 'x' },
        { id: 'r', sourceIp: '::1' },
      );

      await post('/ns/iam/prod', {
        baseCommit: await git.headCommit(),
        message: 'unrelated flag change',
        'key.MFA_ENFORCEMENT': 'all',
        'key.SMTP_PASSWORD': '',
      });

      const loader = new ConfigLoader(new SopsDecryptor(key.secret));
      const tree = await loader.resolve(await git.readSources());
      expect(tree.namespaces.get('iam/prod')).toMatchObject({
        SMTP_PASSWORD: 'hunter2',
        MFA_ENFORCEMENT: 'all',
      });
    });

    it('does not lose what was typed when a save is rejected', async () => {
      // Retyping a form during an incident is how the wrong value gets entered the second time.
      await start();

      const response = await post('/ns/iam/prod', {
        baseCommit: await git.headCommit(),
        message: 'break it',
        'key.SESSION_TTL': '1',
      });

      expect(response.body).toContain('value="1"');
    });
  });
});
