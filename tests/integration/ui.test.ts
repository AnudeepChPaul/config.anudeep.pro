import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { BreakGlass } from '@config/src/auth/break-glass.js';
import { SessionCodec } from '@config/src/auth/session.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { DraftStore } from '@config/src/store/draft-store.js';
import { EnvironmentOrder } from '@config/src/store/environment-order.js';
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

/** Whatever a hostile file happens to hold: the point of those fixtures is the rendering. */
const EVIL_SCHEMA =
  'keys:\n  A:\n    type: string\n  "<img src=x onerror=alert(1)>":\n    type: int\n';

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
      // `evil` is declared by the escaping fixtures; a product with no schema does not render
      // at all now, so it needs one like any other.
      schemas: () => SchemaSet.fromFiles({ iam: SCHEMA, evil: EVIL_SCHEMA }),
      drafts,
      writeService: new ConfigWriteService({
        repository: git,
        loader,
        encryptor: new SopsEncryptor(repo.dir),
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA, evil: EVIL_SCHEMA }),
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
      'services.yaml':
        'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
      'environments.yaml': 'order: [dev, prod]\n',
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
      // Labelled with the uid the read API authenticates against: it is the fact that decides
      // which process may read this product's configuration.
      expect(body).toContain('iam (1002)');
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
      // Declared like any other product: the console renders what services.yaml names, and the
      // point here is that a hostile VALUE in a declared namespace is escaped.
      await repo.commit({
        'config/evil/prod.yaml': "A: '</textarea><script>alert(1)</script>'\n",
        'services.yaml': 'services:\n  - name: evil\n    uid: 1099\n    namespaces: [evil/prod]\n',
      });
      await start();

      const body = (await get('/p/evil?env=prod')).body;

      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).toContain('&lt;script&gt;');
    });

    it('escapes a hostile key name too', async () => {
      await repo.commit({
        'config/evil/prod.yaml': '"<img src=x onerror=alert(1)>": 1\n',
        'services.yaml': 'services:\n  - name: evil\n    uid: 1099\n    namespaces: [evil/prod]\n',
      });
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
        'services.yaml':
          'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
        'environments.yaml': 'order: [dev, prod]\n',
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

describe('publishing ticked keys and promoting them', () => {
  const SCHEMA2 = `keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
  KILL_PASSWORD_LOGIN:
    type: bool
  SMTP_PASSWORD:
    type: string
    secret: true
`;

  const withSops3 = hasSops() ? describe : describe.skip;

  withSops3('from the environment tab', () => {
    let key3: AgeKeypair;
    let repo3: TestRepo;
    let git3: GitRepository;
    let app3: Awaited<ReturnType<typeof buildWebApp>>;

    const post = (url: string, fields: Array<[string, string]>) =>
      app3.inject({
        method: 'POST',
        url,
        payload: new URLSearchParams(fields).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    const served = async (namespace: string) =>
      (
        await new ConfigLoader(new SopsDecryptor(key3.secret)).resolve(await git3.readSources())
      ).namespaces.get(namespace);

    beforeEach(async () => {
      key3 = generateAgeKey();
      repo3 = await TestRepo.create();
      await repo3.commit({
        'schema/iam.yaml': SCHEMA2,
        'environments.yaml': 'order: [dev, prod]\n',
        'services.yaml':
          'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
        'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key3.recipient}\n`,
      });
      git3 = new GitRepository(repo3.dir);
      const loader3 = new ConfigLoader(new SopsDecryptor(key3.secret));
      const drafts3 = new DraftStore(`${repo3.dir}/.drafts.json`);
      app3 = await buildWebApp({
        repository: git3,
        loader: loader3,
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA2 }),
        drafts: drafts3,
        environmentOrder: async () =>
          EnvironmentOrder.fromYaml(await git3.readFile('environments.yaml')),
        writeService: new ConfigWriteService({
          repository: git3,
          loader: loader3,
          encryptor: new SopsEncryptor(repo3.dir),
          schemas: () => SchemaSet.fromFiles({ iam: SCHEMA2 }),
          drafts: drafts3,
        }),
        environment: 'dev',
      });
    });

    afterEach(async () => {
      await app3?.close();
      await rm(repo3.dir, { recursive: true, force: true });
    });

    it('publishes the whole draft, ticked or not', async () => {
      // A draft is the unit: the tick decides what enters one and what promotes, not what a
      // publish leaves behind.
      const response = await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['key.SESSION_TTL', '600'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'publish'],
      ]);

      expect(response.statusCode).toBe(303);
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 600 });
    });

    it('saves without publishing when that is the intent', async () => {
      const before = await git3.headCommit();

      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(await git3.headCommit()).toBe(before);
    });

    it('offers to promote exactly what was published', async () => {
      const response = await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['key.SESSION_TTL', '600'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'publish'],
      ]);

      const location = String(response.headers.location);
      expect(location).toContain('published=MFA_ENFORCEMENT');

      const page = await app3.inject({ method: 'GET', url: location });
      expect(page.body).toMatch(/Save \d+ as a draft in prod\?/);
      expect(page.body).toContain('MFA_ENFORCEMENT');
      // Both keys were published — a draft publishes whole — but only the ticked one is offered
      // for the next environment. Deciding what moves on is what the tick is still for.
      expect(page.body).not.toContain('name="key" value="SESSION_TTL"');
    });

    it('stages the promoted key in the next environment without publishing it', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'publish'],
      ]);

      const response = await post('/promote', [
        ['service', 'iam'],
        ['from', 'dev'],
        ['to', 'prod'],
        ['key', 'MFA_ENFORCEMENT'],
      ]);

      expect(response.statusCode).toBe(303);
      expect(String(response.headers.location)).toContain('env=prod');
      // Staged, not published.
      expect(await served('iam/prod')).toMatchObject({ MFA_ENFORCEMENT: 'optional' });
      expect((await new DraftStore(`${repo3.dir}/.drafts.json`).get('iam/prod'))?.changes).toEqual([
        { key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all', secret: false },
      ]);
    });

    it('does not post a false for a bool that has no override', async () => {
      // The hidden `false` beside a checkbox makes an unticked box mean false rather than
      // "delete the override" — but for a key with NO value it made `false` look like an edit,
      // so merely opening the page and saving staged every unset boolean on the product.
      //
      // The guarantee is in what the form emits, so that is what this asserts: a hand-made post
      // could carry anything and would prove nothing about the page.
      const body = (await app3.inject({ method: 'GET', url: '/p/iam?env=dev' })).body;

      expect(body).toMatch(/name="key.KILL_PASSWORD_LOGIN"/);
      expect(body).not.toContain(
        '<input type="hidden" name="key.KILL_PASSWORD_LOGIN" value="false">',
      );
    });

    it('counts what a promotion actually staged, not what was asked', async () => {
      // dev and prod already agree on SESSION_TTL, so promoting both keys moves one. Reporting
      // two would send the operator looking for a change that is not there.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'publish'],
      ]);

      const response = await post('/promote', [
        ['service', 'iam'],
        ['from', 'dev'],
        ['to', 'prod'],
        ['key', 'MFA_ENFORCEMENT'],
        ['key', 'SESSION_TTL'],
      ]);

      expect(decodeURIComponent(String(response.headers.location))).toContain('Staged 1 change');
    });

    it('offers nothing to promote from the last environment', async () => {
      await post('/p/iam/prod', [
        ['key.MFA_ENFORCEMENT', 'admins'],
        ['select', 'MFA_ENFORCEMENT'],
        ['message', 'Change prod'],
        ['intent', 'publish'],
      ]);

      const page = await app3.inject({
        method: 'GET',
        url: '/p/iam?env=prod&published=MFA_ENFORCEMENT',
      });

      expect(page.body).not.toContain('Stage in');
    });
  });
});

describe('the environment tab offers the controls its routes accept', () => {
  /**
   * Every publish test until now posted to the route directly. That proved the handler works
   * and said nothing about whether the page ever offers it — and for a while it did not: the
   * button was missing from the view while the route, the tests and a curl all passed.
   *
   * So these assert the PAGE: that what a person can click matches what the server accepts.
   */
  const SCHEMA4 = `keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
`;

  const withSops4 = hasSops() ? describe : describe.skip;

  withSops4('as rendered', () => {
    let key4: AgeKeypair;
    let repo4: TestRepo;
    let git4: GitRepository;
    let app4: Awaited<ReturnType<typeof buildWebApp>>;

    const page = async (url = '/p/iam?env=dev') => (await app4.inject({ method: 'GET', url })).body;

    const post = (url: string, fields: Array<[string, string]>) =>
      app4.inject({
        method: 'POST',
        url,
        payload: new URLSearchParams(fields).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    beforeEach(async () => {
      key4 = generateAgeKey();
      repo4 = await TestRepo.create();
      await repo4.commit({
        'schema/iam.yaml': SCHEMA4,
        'environments.yaml': 'order: [dev, prod]\n',
        'services.yaml':
          'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
        'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key4.recipient}\n`,
      });
      git4 = new GitRepository(repo4.dir);
      const loader4 = new ConfigLoader(new SopsDecryptor(key4.secret));
      const drafts4 = new DraftStore(`${repo4.dir}/.drafts.json`);
      app4 = await buildWebApp({
        repository: git4,
        loader: loader4,
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA4 }),
        drafts: drafts4,
        environmentOrder: async () =>
          EnvironmentOrder.fromYaml(await git4.readFile('environments.yaml')),
        writeService: new ConfigWriteService({
          repository: git4,
          loader: loader4,
          encryptor: new SopsEncryptor(repo4.dir),
          schemas: () => SchemaSet.fromFiles({ iam: SCHEMA4 }),
          drafts: drafts4,
        }),
        environment: 'dev',
      });
    });

    afterEach(async () => {
      await app4?.close();
      await rm(repo4.dir, { recursive: true, force: true });
    });

    it('renders both buttons the handler branches on, once there is a draft', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      // Save is absent once everything on the page is drafted, so the pair is shown by adding
      // an edit the draft does not hold.
      expect(body).toContain('name="intent" value="publish"');

      // A page that failed validation has nothing ticked, so the action is offered: hiding it
      // there would leave no way to save the fix.
      const withMore = await app4.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: new URLSearchParams([
          ['key.SESSION_TTL', 'not-a-number'],
          ['intent', 'save'],
        ]).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(withMore.statusCode).toBe(422);
      expect(withMore.body).toContain('name="intent" value="save"');
    });

    it('offers a message field with the publish button, since publishing requires one', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(await page()).toContain('name="message"');
    });

    it('keeps the ticks in the same form as the actions', async () => {
      // In separate forms the ticks are simply not submitted, and a publish would then offer
      // nothing for promotion — the one job the tick still has at publish time.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      const form =
        (await page()).match(/<form[^>]*action="\/p\/iam\/dev"[\s\S]*?<\/form>/)?.[0] ?? '';

      expect(form).toContain('name="select"');
      expect(form).toContain('name="intent" value="publish"');
      expect(form).toContain('name="intent" value="save"');
    });

    it('does not render publishing when there is nothing staged', async () => {
      // Absent rather than disabled: you cannot publish what has not been written down, and a
      // permanently greyed button invites clicking at it to find out why.
      expect(await page()).not.toContain('value="publish"');
    });

    it('renders it enabled once something is staged', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      const button = (await page()).match(/<button[^>]*value="publish"[^>]*>/)?.[0] ?? '';

      expect(button).not.toContain('disabled');
    });

    it('has no second, environment-scoped publish that would ignore the ticks', async () => {
      // Publishing a whole product is a real action and keeps its own form, once there is
      // something in it. What must not survive is a button that publishes just this environment
      // while skipping the selection — two ways to publish, one of which quietly ships more
      // than was ticked.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();
      const productForm = body.match(/<form[^>]*action="\/publish"[\s\S]*?<\/form>/)?.[0] ?? '';

      expect(productForm).toContain('value="iam/dev"');
      expect(productForm).toContain('value="iam/prod"');
      expect(body.match(/action="\/publish"/g) ?? []).toHaveLength(1);
    });

    it('offers a tick on every key, not only the changed ones', async () => {
      // A tick is how you say what goes — to a publish and to the next environment — so a key
      // the form will not offer is a key you cannot send along.
      const body = await page();

      for (const key of ['MFA_ENFORCEMENT', 'SESSION_TTL']) {
        expect(body).toContain(`name="select" value="${key}"`);
      }
    });

    it('starts every key clear, including one the draft holds', async () => {
      // A tick is a selection an action consumes. The save took it; publishing does not read
      // ticks at all, so nothing on a freshly loaded page is selected for anything.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      const tick = (key: string) =>
        body.match(new RegExp(`<input type="checkbox" name="select" value="${key}"[^>]*>`))?.[0] ??
        '';

      expect(tick('MFA_ENFORCEMENT')).not.toContain('checked');
      expect(tick('SESSION_TTL')).not.toContain('checked');
    });
  });
});

describe('the tick and button behaviour the page depends on', () => {
  /**
   * The live half of this is a script, and there is no browser here — so these assert what the
   * script needs in order to work: the original value on every control, the tick it drives, and
   * the buttons it enables. If any of that stops being rendered the behaviour dies silently,
   * which is exactly how the publish button went missing for three commits.
   */
  /** A default, so a declared environment with no file can be created from it. */
  const API_SCHEMA5 =
    'keys:\n  RATE_LIMIT:\n    type: int\n    min: 1\n    max: 1000\n    default: 100\n';

  const SCHEMA5 = `keys:
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
`;

  const withSops5 = hasSops() ? describe : describe.skip;

  withSops5('as rendered', () => {
    let key5: AgeKeypair;
    let repo5: TestRepo;
    let git5: GitRepository;
    let app5: Awaited<ReturnType<typeof buildWebApp>>;

    const page = async () => (await app5.inject({ method: 'GET', url: '/p/iam?env=dev' })).body;

    const post = (url: string, fields: Array<[string, string]>) =>
      app5.inject({
        method: 'POST',
        url,
        payload: new URLSearchParams(fields).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    beforeEach(async () => {
      key5 = generateAgeKey();
      repo5 = await TestRepo.create();
      await repo5.commit({
        'schema/iam.yaml': SCHEMA5,
        'schema/api.yaml': API_SCHEMA5,
        'environments.yaml': 'order: [dev, prod]\n',
        'services.yaml':
          'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n' +
          '  - name: api\n    uid: 1003\n    namespaces: [api/prod]\n',
        // api has prod and no dev: the declared dev tab is the one with no file behind it.
        'config/api/prod.yaml': 'RATE_LIMIT: 50\n',
        'config/iam/dev.yaml':
          'FP_COMPONENTS: [ua, lang]\nKILL_PASSWORD_LOGIN: false\nMFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key5.recipient}\n`,
      });
      git5 = new GitRepository(repo5.dir);
      const loader5 = new ConfigLoader(new SopsDecryptor(key5.secret));
      const drafts5 = new DraftStore(`${repo5.dir}/.drafts.json`);
      app5 = await buildWebApp({
        repository: git5,
        repoWebUrl: 'https://github.com/AnudeepChPaul/config.bare.anudeep.pro',
        loader: loader5,
        schemas: () => SchemaSet.fromFiles({ iam: SCHEMA5, api: API_SCHEMA5 }),
        drafts: drafts5,
        environmentOrder: async () =>
          EnvironmentOrder.fromYaml(await git5.readFile('environments.yaml')),
        writeService: new ConfigWriteService({
          repository: git5,
          loader: loader5,
          encryptor: new SopsEncryptor(repo5.dir),
          schemas: () => SchemaSet.fromFiles({ iam: SCHEMA5, api: API_SCHEMA5 }),
          drafts: drafts5,
        }),
        environment: 'dev',
      });
    });

    afterEach(async () => {
      await app5?.close();
      await rm(repo5.dir, { recursive: true, force: true });
    });

    it('gives every control the value it started with', async () => {
      // The script compares against this rather than tracking edits, so typing a value and
      // typing it back leaves no tick behind.
      const body = await page();

      expect(body).toMatch(/name="key.MFA_ENFORCEMENT"[^>]*data-original="optional"/s);
      expect(body).toMatch(/name="key.SESSION_TTL"[^>]*data-original="900"/s);
      expect(body).toMatch(/name="key.KILL_PASSWORD_LOGIN"[^>]*data-original="false"/s);
      expect(body).toMatch(/name="key.FP_COMPONENTS"[^>]*data-original="ua, lang"/s);
    });

    it('links each control to the tick it drives', async () => {
      const body = await page();

      for (const key of ['MFA_ENFORCEMENT', 'SESSION_TTL', 'KILL_PASSWORD_LOGIN']) {
        expect(body).toContain(`data-key="${key}"`);
        expect(body).toContain(`data-select="${key}"`);
      }
    });

    it('marks the form the script attaches to', async () => {
      expect(await page()).toMatch(/<form[^>]*data-keys/s);
    });

    it('puts the actions directly under the tabs, above the fields', async () => {
      const body = await page();

      expect(body.indexOf('class="tabs"')).toBeLessThan(body.indexOf('value="save"'));
      expect(body.indexOf('value="save"')).toBeLessThan(body.indexOf('name="key.MFA_ENFORCEMENT"'));
    });

    it('keeps the actions inside the form that carries the ticks', async () => {
      // Outside it they would submit neither the selection nor the values.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const form = (await page()).match(/<form[^>]*data-keys[\s\S]*?<\/form>/)?.[0] ?? '';

      expect(form).toContain('value="publish"');
      expect(form).toContain('name="select"');
      expect(form).toContain('name="key.MFA_ENFORCEMENT"');
    });

    it('disables saving when nothing is ticked, and offers no publish at all', async () => {
      const body = await page();

      expect(body.match(/<button[^>]*value="save"[^>]*>/)?.[0]).toContain('disabled');
      expect(body).not.toContain('value="publish"');
      // The toolbar's message box, not the publish-everything form's hidden one.
      expect(body).not.toContain('id="message"');
    });

    it('reveals publishing, enabled, once a draft exists', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      expect(body.match(/<button[^>]*value="publish"[^>]*>/)?.[0]).not.toContain('disabled');
    });

    it('never asks for a message, since every commit message is generated', async () => {
      // An operator mid-incident has better things to do than compose a subject line.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(await page()).not.toContain('id="message"');
    });

    it('recounts a swapped-in page rather than inheriting the previous one', async () => {
      const script = (await app5.inject({ method: 'GET', url: '/assets/ticks.js' })).body;

      expect(script).toContain('htmx:afterSwap');
      expect(script).toContain('data-publish-action');
    });

    it('gives the buttons a label the script can recount', async () => {
      // The number on the button has to follow the ticks, or it states a count that was true
      // when the page was built and is not now.

      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const staged = await page();

      // The publish label is not recounted from ticks: publishing ships whole drafts, so its
      // number is the server's count of saves.
      expect(staged).toMatch(/Publish 1 draft in dev\?/);
      expect(staged).toContain('data-needs-ticks');
    });

    it('offers no draft action once everything on the page is already drafted', async () => {
      // Pressing Draft again would write the same document a second time and count a revision
      // for it. There is nothing left to draft until something else moves.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      // Hidden rather than removed, so the script can bring it back the moment something on
      // the page is not in the draft — without a round trip to find that out.
      expect(body).toMatch(/<span data-draft-action hidden>/);
      expect(body).toContain('value="publish"');
    });

    it('enables publishing what the draft holds, without needing a fresh tick', async () => {
      // The draft is the selection: it was chosen when it was saved, and a page load must not
      // silently unselect it.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const publish = (await page()).match(/<button[^>]*value="publish"[^>]*>/)?.[0] ?? '';

      expect(publish).not.toContain('disabled');
    });

    it('drafts a tick-only selection, and publishing it needs no tick at all', async () => {
      // A tick-only draft moves no value, so the count comes from the saves rather than from
      // comparing values — and the tick itself is cleared, having been acted on.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'optional'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'save'],
      ]);
      const body = await page();

      expect(body).not.toMatch(/data-select="MFA_ENFORCEMENT"[^>]*checked/);
      expect(body).toMatch(/Publish 1 draft in dev\?/);
    });

    it('brings the draft action back the moment something else moves', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const script = (await app5.inject({ method: 'GET', url: '/assets/ticks.js' })).body;

      // The page carries what is drafted, so the script can tell a fresh tick from a saved one.
      expect(await page()).toContain('data-drafted="MFA_ENFORCEMENT"');
      expect(script).toContain('data-drafted');
    });

    it('says the publish is done, and marks that notice as one to clear', async () => {
      // A reachable remote, so the push actually happens: the confirmation is only self-clearing
      // when there is nothing left to act on.
      await repo5.addRemote();
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const done = await app5.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: new URLSearchParams([
          ['key.MFA_ENFORCEMENT', 'all'],
          ['select', 'MFA_ENFORCEMENT'],
          ['intent', 'publish'],
          ['message', 'ship it'],
        ]).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
      });

      expect(done.body).toContain('Done publishing.');
      // Rendered by the server, so it appears with the swap and appears without JavaScript too.
      // Only its removal is script-driven, which is the half that is safe to lose.
      expect(done.body).toMatch(/data-transient/);
    });

    it('does not mark a publish that never reached the remote as one to clear', async () => {
      // The commit is durable and being served, but it is not backed up anywhere. A page that
      // erases the only report of that after five seconds is worse than one that never said it.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'admins'],
        ['intent', 'save'],
      ]);
      const done = await app5.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: new URLSearchParams([
          ['key.MFA_ENFORCEMENT', 'admins'],
          ['select', 'MFA_ENFORCEMENT'],
          ['intent', 'publish'],
          ['message', 'ship it'],
        ]).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
      });

      // This repository has no remote at all, so the push cannot have happened.
      expect(done.body).toMatch(/not yet pushed/);
      const notice = done.body.match(
        /<div class="card"[^>]*>[\s\S]*?not yet pushed[\s\S]*?<\/div>/,
      );
      expect(notice?.[0]).not.toContain('data-transient');
    });

    it('clears a transient notice after five seconds, and only a transient one', async () => {
      const script = (await app5.inject({ method: 'GET', url: '/assets/ticks.js' })).body;

      expect(script).toContain('data-transient');
      expect(script).toContain('5000');
    });

    it('drafts a ticked key whose value has not moved, rather than refusing', async () => {
      // Ticking a key is how you say "send this one along". Refusing to write that down —
      // "nothing changed, a tick on its own does not make a draft" — threw the intent away and
      // made the button look broken.
      const fields = new URLSearchParams([
        ['key.MFA_ENFORCEMENT', 'optional'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'save'],
      ]).toString();

      const swapped = await app5.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: fields,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
      });

      expect(swapped.statusCode).toBe(200);
      expect(swapped.body).not.toMatch(/nothing changed/i);
      // A draft exists now, so it can be published — and from there promoted.
      expect(swapped.body).toContain('value="publish"');
    });

    it('answers a save that changes nothing with a notice, not a 422', async () => {
      // A tick is not an edit. Ticking three keys and saving used to fall through the
      // validation branch and return 422 with a per-key error page that had no per-key errors
      // on it — the operator saw a red page and no cause.
      // No edit and no tick: there is genuinely nothing to write down.
      const fields = new URLSearchParams([
        ['key.MFA_ENFORCEMENT', 'optional'],
        ['intent', 'save'],
      ]).toString();

      // The page htmx sees: the answer itself, rather than a redirect to it.
      const swapped = await app5.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: fields,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'hx-request': 'true',
        },
      });

      expect(swapped.statusCode).toBe(200);
      expect(swapped.body).toMatch(/nothing to save/i);
      // And nothing was written down, so there is still nothing to publish.
      expect(swapped.body).not.toContain('value="publish"');

      // Without htmx it is the same answer through a redirect, not an error page.
      const plain = await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'optional'],
        ['intent', 'save'],
      ]);

      expect(plain.statusCode).toBe(303);
      expect(plain.headers.location).toMatch(/notice=/);
    });

    it('offers to create a declared environment that has no file yet', async () => {
      // api/dev is declared by environments.yaml and has no file. The tab renders, and asks
      // before creating anything: a click should not write a file nobody reviewed.
      const page = (await app5.inject({ method: 'GET', url: '/p/api?env=dev' })).body;

      expect(page).toMatch(/no file/i);
      expect(page).toContain('name="intent" value="create"');
      // Read-only until it exists: there is nothing to edit before the file does.
      expect(page).not.toContain('name="key.RATE_LIMIT"');
      expect(page).toContain('RATE_LIMIT');
    });

    it('keeps offering after the offer is declined', async () => {
      const page = (await app5.inject({ method: 'GET', url: '/p/api?env=dev&create=no' })).body;

      // The prompt is gone; the action it offered is not.
      expect(page).not.toContain('It is staged as a draft');
      expect(page).toContain('name="intent" value="create"');
    });

    it('stages one draft of the schema defaults when the offer is accepted', async () => {
      await post('/p/api/dev', [['intent', 'create']]);

      const page = (await app5.inject({ method: 'GET', url: '/p/api?env=dev' })).body;

      expect(page).toMatch(/Publish 1 draft in dev\?/);
      // The declared defaults, written as values: once the file exists they are what the
      // service runs on.
      expect(page).toMatch(/value="100"/);
    });

    it('clears the selection once the draft has taken it', async () => {
      // The ticks said what to save. They have been acted on, so leaving them set reads as a
      // selection still waiting for something.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'save'],
      ]);

      const body = await page();

      expect(body).not.toMatch(/data-select="MFA_ENFORCEMENT"[^>]*checked/);
    });

    it('filters the product list to products holding a matching key', async () => {
      const found = (await app5.inject({ method: 'GET', url: '/?q=SESSION' })).body;

      expect(found).toContain('iam (1002)');
      expect(found).toContain('SESSION_TTL');
      // api declares RATE_LIMIT and nothing matching, so it is not in the list.
      expect(found).not.toContain('api (1003)');
    });

    it('matches without regard to case, and says when nothing matched', async () => {
      expect((await app5.inject({ method: 'GET', url: '/?q=session' })).body).toContain(
        'SESSION_TTL',
      );
      expect((await app5.inject({ method: 'GET', url: '/?q=zzz' })).body).toMatch(/no key/i);
    });

    it('links a match to that product at dev, with the key marked', async () => {
      const found = (await app5.inject({ method: 'GET', url: '/?q=SESSION' })).body;

      expect(found).toContain('/p/iam?env=dev&hl=SESSION_TTL');
    });

    it('marks the key a link arrived for, and marks nothing for a key that is not there', async () => {
      const marked = (await app5.inject({ method: 'GET', url: '/p/iam?env=dev&hl=SESSION_TTL' }))
        .body;

      expect(marked).toMatch(/class="[^"]*found[^"]*"/);
      expect(marked).toContain('.found');

      const nothing = (await app5.inject({ method: 'GET', url: '/p/iam?env=dev&hl=NOPE' })).body;
      expect(nothing).not.toMatch(/class="[^"]*found[^"]*"/);
    });

    it('filters the fields inside a product, and navigates nowhere', async () => {
      const filtered = (await app5.inject({ method: 'GET', url: '/p/iam?env=dev&q=SESSION' })).body;

      expect(filtered).toContain('name="key.SESSION_TTL"');
      expect(filtered).not.toContain('name="key.MFA_ENFORCEMENT"');
      // Still the product page, not a results page.
      expect(filtered).toContain('class="tabs"');
    });

    it('offers the search as a plain form, so it works without the script', async () => {
      const body = await page();

      expect(body).toMatch(/<form[^>]*method="get"[^>]*>[\s\S]*?name="q"/);
    });

    it('shows key names and no values at all, secrets included', async () => {
      // Search reads key NAMES from the schema. Searching values over a registry that holds
      // secrets becomes a way to confirm one by guessing, so no value is matched or rendered.
      const found = (await app5.inject({ method: 'GET', url: '/?q=SESSION' })).body;

      expect(found).toContain('SESSION_TTL');
      // dev holds 900 and prod 3600; neither belongs in a list of key names.
      expect(found).not.toContain('>900<');
      expect(found).not.toContain('>3600<');
    });

    it('lists every unpublished draft, with what each save changed', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      await post('/p/iam/dev', [
        ['key.SESSION_TTL', '1200'],
        ['intent', 'save'],
      ]);

      const list = (await app5.inject({ method: 'GET', url: '/drafts' })).body;

      expect(list).toContain('iam/dev');
      expect(list).toContain('MFA_ENFORCEMENT');
      expect(list).toContain('SESSION_TTL');
      // One Drop per save, addressed by its position.
      expect(list).toMatch(/name="index" value="0"/);
      expect(list).toMatch(/name="index" value="1"/);
    });

    it('says so plainly when nothing is drafted anywhere', async () => {
      expect((await app5.inject({ method: 'GET', url: '/drafts' })).body).toMatch(/nothing/i);
    });

    it('drops the save it is asked to drop, and leaves the other', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      await post('/p/iam/dev', [
        ['key.SESSION_TTL', '1200'],
        ['intent', 'save'],
      ]);

      await post('/drafts/drop', [
        ['namespace', 'iam/dev'],
        ['index', '0'],
      ]);
      const list = (await app5.inject({ method: 'GET', url: '/drafts' })).body;

      expect(list).toContain('SESSION_TTL');
      expect(list).not.toContain('MFA_ENFORCEMENT');
    });

    it('asks before dropping, since a draft is not in git and nothing undoes it', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect((await app5.inject({ method: 'GET', url: '/drafts' })).body).toContain('hx-confirm');
    });

    it('links the draft list from the product list, with the count on it', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect((await app5.inject({ method: 'GET', url: '/' })).body).toContain('href="/drafts"');
    });

    it('marks a declared product whose schema is missing, and refuses to open it', async () => {
      // Without a schema every save fails validation at the last step, after the values are
      // typed. Better to say so on the list than to let someone find out at the end.
      await repo5.commit({
        'services.yaml':
          'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n' +
          '  - name: audit\n    uid: 1004\n    namespaces: [audit/prod]\n',
      });

      const list = (await app5.inject({ method: 'GET', url: '/' })).body;

      expect(list).toContain('schema is missing');
      expect(list).toContain('audit (1004)');
      // Not a link: there is nowhere useful for it to go.
      expect(list).not.toMatch(/href="\/p\/audit"/);
      expect((await app5.inject({ method: 'GET', url: '/p/audit' })).statusCode).toBe(404);
    });

    it('renders a tab for every declared environment, file or no file', async () => {
      // The tabs come from environments.yaml, not from what happens to be in the tree: you open
      // the tab in order to write to it, so requiring a file first is backwards.
      const body = await page();

      expect(body).toMatch(/href="\/p\/iam\?env=dev"/);
      expect(body).toMatch(/href="\/p\/iam\?env=prod"/);
    });

    it('renders no tab for an environment nobody declared', async () => {
      await repo5.commit({ 'config/iam/staging.yaml': 'MFA_ENFORCEMENT: all\n' });

      expect(await page()).not.toContain('env=staging');
    });

    it('counts drafts, not keys, on the publish action', async () => {
      // One press of Save is one draft, whatever it contained.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['key.SESSION_TTL', '1200'],
        ['intent', 'save'],
      ]);
      expect(await page()).toMatch(/Publish 1 draft in dev\?/);

      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'admins'],
        ['intent', 'save'],
      ]);

      expect(await page()).toMatch(/Publish 2 drafts in dev\?/);
    });

    it('names a page-local edit unsaved and a drafted change unpublished', async () => {
      const clean = await page();
      expect(clean).toContain('data-label="{n} unsaved change{s}."');

      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const drafted = await page();

      // Both labels are on the page: the script picks between them, because only it knows
      // whether anything on the page is unsaved.
      expect(drafted).toContain('data-label="{n} unsaved change{s}."');
      expect(drafted).toContain('data-drafted-label="1 unpublished change."');
      expect(drafted).toContain('1 unpublished change.');
    });

    it('says save for the draft action and publish for the publish action', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      expect(body).toContain('Save {n} change{s} as draft?');
      expect(body).toMatch(/Publish 1 draft in dev\?/);
    });

    it('states what is selected as a sentence the script can recount', async () => {
      const body = await page();

      expect(body).toContain('data-label="{n} unsaved change{s}."');
    });

    it('hides the selection while nothing is selected, showing where you are instead', async () => {
      const body = await page();

      expect(body).toMatch(/<span class="selection" data-selection hidden/);
      expect(body).toContain('class="idle"');
    });

    /** The idle line holds nested spans, so it runs to the selection that follows it. */
    const idleLine = (body: string) =>
      body.slice(body.indexOf('class="idle"'), body.indexOf('class="selection"'));

    it('never renders the document version as an editable key', async () => {
      // It is metadata the file carries about itself. A row for it would invite editing a
      // counter the write path maintains, and the schema has no definition to render it with.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      expect(body).not.toContain('name="key.version"');
      expect(body).not.toContain('data-select="version"');
    });

    it('does not count a publish as a revision of its own', async () => {
      // The publish posts the same form, ticks and all. Recording those as a selection would
      // bump the counter on every publish, on top of the draft save that preceded it.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'publish'],
        ['message', 'ship it'],
      ]);

      expect(idleLine(await page())).toMatch(/revision 1/);
    });

    it('shows the revision in the idle line, where the rest of the file is described', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'publish'],
        ['message', 'ship it'],
      ]);

      expect(idleLine(await page())).toMatch(/revision 1/);
    });

    it('fills the idle line with where you are, rather than leaving it blank', async () => {
      const body = await page();
      const line = idleLine(body);

      // What this environment holds, and what is being served.
      expect(line).toMatch(/4 variables in dev/);
      expect(line).toContain('serving');
    });

    it('links the commit it is serving to the commit on GitHub', async () => {
      const line = idleLine(await page());

      expect(line).toMatch(
        /href="https:\/\/github\.com\/AnudeepChPaul\/config\.bare\.anudeep\.pro\/commit\/[0-9a-f]{40}"/,
      );
      // A link off the console opens away from it, and carries no referrer.
      expect(line).toContain('rel="noreferrer"');
    });

    it('says nothing about drift against the next environment', async () => {
      // It was noise on a line whose job is to say where you are.
      expect(idleLine(await page())).not.toMatch(/differ from/);
    });

    it('names the last publish, which is the entry above the one you are about to write', async () => {
      const line = idleLine(await page());

      expect(line).toMatch(/last published/i);
    });

    it('drops the idle line the moment the toolbar has something to say', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(await page()).not.toContain('class="idle"');
    });

    it('holds the toolbar height whether or not the toolbar is there', async () => {
      // Appearing on the first tick would otherwise push every field down the page, under a
      // cursor that is aimed at one of them.
      const body = await page();

      expect(body).toContain('class="actionslot"');
      expect(body).toMatch(/\.actionslot \{ min-height:/);
    });

    it('keeps the toolbar once a draft exists, which is publishable either way', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      expect(body).toContain('data-has-draft');
      expect(body).toMatch(/<span class="selection" data-selection\s+data-drafted=/);
    });

    it('renders the actions as links in the sentence, not as boxed buttons', async () => {
      // They read as the end of the sentence — "1 unpublished change selected. Save as draft?" —
      // rather than as a control bar bolted above the fields.
      const save = (await page()).match(/<button[^>]*value="save"[^>]*>/)?.[0] ?? '';

      expect(save).toContain('class="linkbtn"');
      expect(save).not.toContain('ghost');
    });

    it('keeps the publish action in the same register once a draft exists', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const publish = (await page()).match(/<button[^>]*value="publish"[^>]*>/)?.[0] ?? '';

      expect(publish).toContain('linkbtn');
    });

    it('leaves the draft count hoverable, so you can see what is in it', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const body = await page();

      // The same hover panel the tabs and the product list use, hung off the count itself.
      expect(body).toContain('class="pending sel"');
      expect(body).toContain('data-detail');
      expect(body.slice(body.indexOf('data-detail'))).toContain('MFA_ENFORCEMENT');
    });

    it('styles a tick you are not allowed to clear differently from one you are', async () => {
      const body = await page();

      expect(body).toContain('.keypick input.locked');
      expect(body).toContain('.linkbtn:disabled');
    });

    it('serves the script that does all of it', async () => {
      const body = await page();
      expect(body).toContain('src="/assets/ticks.js"');

      const script = await app5.inject({ method: 'GET', url: '/assets/ticks.js' });
      expect(script.statusCode).toBe(200);
      expect(script.body).toContain('data-original');
    });
  });
});
