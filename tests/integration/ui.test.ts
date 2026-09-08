import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { BreakGlass } from '@config/src/auth/break-glass.js';
import { SessionCodec } from '@config/src/auth/session.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { DraftStore } from '@config/src/store/draft-store.js';
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

  let drafts: DraftStore;

  const start = async (options: { environment?: string; authenticated?: boolean } = {}) => {
    drafts = new DraftStore(`${repo.dir}/.drafts.json`);
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
      drafts,
      writeService: new ConfigWriteService({
        repository: git,
        loader,
        encryptor: new SopsEncryptor(repo.dir),
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
        drafts,
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

      // Products, not namespaces: the index no longer lists an environment at all.
      expect(body).toContain('>iam<');
      expect(body).not.toContain('iam/prod');
    });

    it('summarises the keys across every environment, not just one', async () => {
      // Taking the first environment's keys presents dev's configuration as the product's,
      // which is wrong the moment two environments differ — which is the point of having them.
      await repo.commit({ 'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\n' });
      await start();

      const body = (await get('/')).body;

      expect(body).toContain('MFA_ENFORCEMENT');
      expect(body).toContain('SESSION_TTL');
    });

    it('shows the commit being served', async () => {
      await start();

      expect((await get('/')).body).toContain((await git.headCommit()).slice(0, 8));
    });
  });

  describe('viewing a namespace', () => {
    it('lists the keys and their values', async () => {
      await start();

      const body = (await get('/p/iam?env=prod')).body;

      expect(body).toContain('MFA_ENFORCEMENT');
      expect(body).toContain('optional');
      expect(body).toContain('SESSION_TTL');
    });

    it('offers the schema enum values rather than a free text box', async () => {
      // Typing a value that the validator will reject is a round trip an operator does not need
      // during an incident.
      await start();

      const body = (await get('/p/iam?env=prod')).body;

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

      const body = (await get('/p/iam?env=prod')).body;

      expect(body).toContain('SMTP_PASSWORD');
      expect(body).not.toContain('hunter2');
    });

    it('says a secret is set without saying what it is', async () => {
      await start();

      expect((await get('/p/iam?env=prod')).body).toMatch(/SMTP_PASSWORD/);
    });

    it('shows the staged value rather than the published one once an edit is pending', async () => {
      // The editor should show what will be published, not what was published last — otherwise
      // an operator re-reads their own pending change as if it had not been made.
      await start();
      await post('/p/iam/prod', { 'key.MFA_ENFORCEMENT': 'all' });

      const body = (await get('/p/iam?env=prod')).body;

      expect(body).toContain('value="all"');
    });

    it('returns 404 for a namespace that does not exist', async () => {
      await start();

      expect((await get('/p/nope')).statusCode).toBe(404);
    });
  });

  describe('escaping', () => {
    it('escapes a value that would otherwise close the element it sits in', async () => {
      // The config repo is writable through GitHub as well as through this UI, so a hostile
      // value can arrive without ever passing through this form's validation.
      await repo.commit({ 'config/evil/prod.yaml': "A: '</textarea><script>alert(1)</script>'\n" });
      await start();

      const body = (await get('/p/evil?env=prod')).body;

      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).toContain('&lt;script&gt;');
    });

    it('escapes a hostile key name too', async () => {
      await repo.commit({ 'config/evil/prod.yaml': '"<img src=x onerror=alert(1)>": 1\n' });
      await start();

      expect((await get('/p/evil?env=prod')).body).not.toContain('<img src=x');
    });
  });

  describe('saving', () => {
    it('applies a change and redirects back to the namespace', async () => {
      await start();

      const response = await post('/p/iam/prod', {
        baseCommit: await git.headCommit(),
        message: 'tighten MFA',
        'key.MFA_ENFORCEMENT': 'all',
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/p/iam?env=prod');
      expect((await get('/p/iam?env=prod')).body).toContain('all');
    });

    it('shows validation errors instead of applying the change', async () => {
      await start();
      const before = await git.headCommit();

      const response = await post('/p/iam/prod', { 'key.SESSION_TTL': '1' });

      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('SESSION_TTL');
      expect(await git.headCommit()).toBe(before);
    });

    it('says so when a draft was overtaken by an edit in the repository', async () => {
      // Staleness moved from the form to the draft: a draft is built from the values committed
      // at the time, so publishing must refuse if the file has moved since.
      await start();
      await post('/p/iam/prod', { 'key.MFA_ENFORCEMENT': 'all' });
      await repo.commit({ 'config/iam/prod.yaml': 'MFA_ENFORCEMENT: admins\nSESSION_TTL: 7200\n' });

      const response = await post('/publish', { namespace: 'iam/prod', message: 'go' });

      expect(response.statusCode).toBe(303);
      expect(decodeURIComponent(String(response.headers.location))).toMatch(/changed since/i);
    });

    it('publishes nothing when the selection has no pending changes', async () => {
      await start();

      const response = await post('/publish', { namespace: 'iam', message: 'go' });

      expect(decodeURIComponent(String(response.headers.location))).toMatch(/nothing selected/i);
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

      await post('/p/iam/prod', { 'key.MFA_ENFORCEMENT': 'all', 'key.SMTP_PASSWORD': '' });
      await post('/publish', { namespace: 'iam/prod', message: 'unrelated flag change' });

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

      const response = await post('/p/iam/prod', { 'key.SESSION_TTL': '1' });

      expect(response.body).toContain('value="1"');
    });
  });
});

describe('the controls a key renders', () => {
  // The schema declares the type; the console must not make an operator type "true" into a text
  // box or guess an integer's bounds. These assert the control, not the styling.
  const TYPED_SCHEMA = `keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
  KILL_PASSWORD_LOGIN:
    type: bool
  FP_COMPONENTS:
    type: string[]
  SMTP_PASSWORD:
    type: string
    secret: true
`;

  const withSops2 = hasSops() ? describe : describe.skip;

  withSops2('by declared type', () => {
    let key2: AgeKeypair;
    let repo2: TestRepo;
    let git2: GitRepository;
    let app2: Awaited<ReturnType<typeof buildWebApp>>;

    beforeEach(async () => {
      key2 = generateAgeKey();
      repo2 = await TestRepo.create();
      await repo2.commit({
        'schema/iam.yaml': TYPED_SCHEMA,
        'config/iam/prod.yaml':
          'FP_COMPONENTS: [ua, lang]\nKILL_PASSWORD_LOGIN: false\nMFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
        'config/iam/dev.yaml': 'MFA_ENFORCEMENT: all\nSESSION_TTL: 900\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key2.recipient}\n`,
      });
      git2 = new GitRepository(repo2.dir);
      const loader2 = new ConfigLoader(new SopsDecryptor(key2.secret));
      const drafts2 = new DraftStore(`${repo2.dir}/.drafts.json`);
      app2 = await buildWebApp({
        repository: git2,
        loader: loader2,
        schemas: () => SchemaSet.fromFiles({ iam: TYPED_SCHEMA }),
        drafts: drafts2,
        writeService: new ConfigWriteService({
          repository: git2,
          loader: loader2,
          encryptor: new SopsEncryptor(repo2.dir),
          schemas: () => SchemaSet.fromFiles({ iam: TYPED_SCHEMA }),
          drafts: drafts2,
        }),
        environment: 'dev',
      });
    });

    afterEach(async () => {
      await app2?.close();
      await rm(repo2.dir, { recursive: true, force: true });
    });

    const page = async () => (await app2.inject({ method: 'GET', url: '/p/iam?env=prod' })).body;

    it('renders an int as a number box carrying the schema bounds', async () => {
      const body = await page();

      expect(body).toMatch(/<input type="number"[^>]*name="key.SESSION_TTL"/);
      expect(body).toContain('min="60"');
      expect(body).toContain('max="86400"');
    });

    it('renders a bool as a checkbox with a hidden false beside it', async () => {
      // Without the hidden field an unticked box posts nothing, which the write path reads as
      // "delete the override" rather than "set it to false".
      const body = await page();

      expect(body).toContain('<input type="hidden" name="key.KILL_PASSWORD_LOGIN" value="false">');
      expect(body).toMatch(/<input type="checkbox"[^>]*name="key.KILL_PASSWORD_LOGIN"/);
    });

    it('renders an enum as a list of its declared values', async () => {
      const body = await page();

      expect(body).toMatch(/<select[^>]*name="key.MFA_ENFORCEMENT"/);
      for (const value of ['optional', 'admins', 'all'])
        expect(body).toContain(`>${value}</option>`);
    });

    it('renders a list as chips over a single field', async () => {
      const body = await page();

      expect(body).toContain('class="chip-item"');
      expect(body).toContain('value="ua, lang"');
    });

    it('renders a secret as a password field that shows nothing', async () => {
      const body = await page();

      expect(body).toMatch(/<input type="password"[^>]*name="key.SMTP_PASSWORD"/);
    });

    it('turns an unticked checkbox into false rather than a deletion', async () => {
      await app2.inject({
        method: 'POST',
        url: '/p/iam/prod',
        payload: new URLSearchParams([['key.KILL_PASSWORD_LOGIN', 'false']]).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      const loader = new ConfigLoader(new SopsDecryptor(key2.secret));
      const draft = await new DraftStore(`${repo2.dir}/.drafts.json`).get('iam/prod');
      // Unchanged, so nothing should be staged at all.
      expect(draft).toBeNull();
      expect(
        (await loader.resolve(await git2.readSources())).namespaces.get('iam/prod'),
      ).toMatchObject({ KILL_PASSWORD_LOGIN: false });
    });

    it('shows what another environment holds for the same key', async () => {
      const body = await page();

      expect(body).toContain('In other environments');
      expect(body).toContain('class="peek"');
    });
  });
});
