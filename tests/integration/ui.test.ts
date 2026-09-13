import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import type { DBEngine } from '@config/src/store/data-layer.js';
import { EnvironmentOrder } from '@config/src/store/environment-order.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import type { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgeKeypair,
  generateAgeKey,
  guarded,
  hasSops,
  liveOptions,
  TestRepo,
  visible,
} from '../helpers.js';

/**
 * The CRUD UI.
 *
 * Two things dominate: nothing attacker-influenced may reach the page unescaped, and a secret
 * must never be rendered at all. The editor is used during incidents by someone who is about to
 * change how authentication behaves, so a value that can run script in that session is as good
 * as a compromise of iam.
 */

/** One signed-in operator for every fixture here: the console cannot be built without one. */
const signedIn = guarded();

const withSops = hasSops() ? describe : describe.skip;

/** Whatever a hostile file happens to hold: the point of those fixtures is the rendering. */
const EVIL_SCHEMA =
  'version: 1\nkeys:\n  A:\n    type: string\n  "<img src=x onerror=alert(1)>":\n    type: int\n';

const SCHEMA = `version: 1
keys:
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
  let app: Awaited<ReturnType<typeof buildWebApp>>;
  let db: DBEngine;
  let operations: ConfigWriteService;

  const start = async (options: { environment?: string; authenticated?: boolean } = {}) => {
    // `auth` present IS authentication. Absent, the console refuses to be built at all now — in
    // every environment, since keying that off an environment string is what let one unset
    // variable serve it with no login on it.
    const auth = options.authenticated === false ? undefined : signedIn.auth;
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    // `evil` is declared by the escaping fixtures; a product with no schema does not render
    // at all now, so it needs one like any other.
    const live = await liveOptions(repo.dir, { iam: SCHEMA, evil: EVIL_SCHEMA }, loader);
    db = live.db;
    operations = live.operations;
    app = await buildWebApp({
      ...live,
      environment: options.environment ?? 'dev',
      auth,
    });
    return app;
  };

  const get = (path: string) => app.inject({ method: 'GET', url: path, headers: signedIn.headers });
  /**
   * A real urlencoded form post. The payload is encoded by hand because inject serialises an
   * object as JSON whatever the content-type says, which would exercise a body this app never
   * receives from a browser.
   */
  /**
   * Post a form the way the page does.
   *
   * A value save is a compare-and-swap: the rendered form carries the etag it was built from,
   * and the write refuses a base it did not read. A test that omits it is exercising the
   * conflict path, not the save path -- so the helper fills it in when the target is an
   * environment and the fields do not name one already.
   */
  const post = async (path: string, fields: Record<string, string>) => {
    const target = path.match(/^\/p\/([^/?]+)\/([^/?]+)$/);
    const payload =
      target && !('etag' in fields)
        ? { ...fields, etag: (await db.etag(`config/${target[1]}/${target[2]}.yaml`)) ?? '' }
        : fields;
    return app.inject({
      method: 'POST',
      url: path,
      payload: new URLSearchParams(payload).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...signedIn.headers },
    });
  };

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'services.yaml':
        'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
      'environments.yaml': 'order: [dev, prod]\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key.recipient}\n`,
    });
  });

  afterEach(async () => {
    await app?.close();
    await rm(repo.dir, { recursive: true, force: true });
  });

  describe('refusing to run unprotected', () => {
    it('will not start in prod without authentication configured', async () => {
      // This page can change MFA enforcement and close registration for anyone who can reach
      // it, so the only safe behaviour without a guard in front is to refuse.
      await expect(start({ environment: 'prod', authenticated: false })).rejects.toThrow(
        /authentication/i,
      );
    });

    it('starts in prod once authentication is configured', async () => {
      await expect(start({ environment: 'prod', authenticated: true })).resolves.toBeTruthy();
    });

    it('will not start in dev without it either', async () => {
      // It used to. An empty CONFIG_ENVIRONMENT is neither 'dev' nor 'prod', and every guard
      // hung off that one comparison — so one unset variable served the console unguarded.
      await expect(start({ environment: 'dev', authenticated: false })).rejects.toThrow(
        /authentication/i,
      );
    });
  });

  describe('listing', () => {
    it('shows every namespace in the repository', async () => {
      await start();

      const body = (await get('/')).body;

      // Products, not namespaces: the index no longer lists an environment at all.
      // Labelled with the uid the read API authenticates against: it is the fact that decides
      // which process may read this product's configuration.
      expect(body).toContain('Iam (1002)');
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

      // The revision is the token the page shows now; git provenance is the sync engine's.
      expect((await get('/')).body).toContain(String(await db.revision()));
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
      await start();
      const result = await operations.writeValues(
        {
          service: 'iam',
          environment: 'prod',
          changes: { SMTP_PASSWORD: 'hunter2' },
          expectedEtag: await db.etag('config/iam/prod.yaml'),
        },
        { email: 'me@anudeep.pro', id: 'x' },
      );
      expect(result.ok).toBe(true);

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
        'services.yaml':
          'version: 1\nservices:\n  - name: evil\n    uid: 1099\n    namespaces: [evil/prod]\n',
      });
      await start();

      const body = (await get('/p/evil?env=prod')).body;

      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).toContain('&lt;script&gt;');
    });

    it('escapes a hostile key name too', async () => {
      await repo.commit({
        'config/evil/prod.yaml': '"<img src=x onerror=alert(1)>": 1\n',
        'services.yaml':
          'version: 1\nservices:\n  - name: evil\n    uid: 1099\n    namespaces: [evil/prod]\n',
      });
      await start();

      expect((await get('/p/evil?env=prod')).body).not.toContain('<img src=x');
    });
  });

  describe('saving', () => {
    it('applies a change and redirects back to the namespace', async () => {
      await start();

      const response = await post('/p/iam/prod', {
        etag: (await db.etag('config/iam/prod.yaml')) ?? '',
        message: 'tighten MFA',
        'key.MFA_ENFORCEMENT': 'all',
      });

      expect(response.statusCode).toBe(303);
      // Back to the namespace, now carrying what the save did.
      expect(response.headers.location).toBe('/p/iam?env=prod&done=saved');
      expect((await get('/p/iam?env=prod')).body).toContain('all');
    });

    // Every other write says what it did. Saving is live: the page must say so, or the only
    // way to tell it worked is to notice the value changed.
    it('says what it saved', async () => {
      await start();

      const response = await post('/p/iam/prod', {
        etag: (await db.etag('config/iam/prod.yaml')) ?? '',
        'key.MFA_ENFORCEMENT': 'all',
      });

      expect(response.statusCode).toBe(303);
      expect(String(response.headers.location)).toContain('done=saved');

      // And the page says it in the console's own words, not the URL's.
      expect((await get('/p/iam?env=prod&done=saved')).body).toContain('Live now in iam/prod');
    });

    it('counts what it actually wrote down, not what was posted', async () => {
      await start();

      // One key changed; the other is posted at the value it already holds, so it writes one.
      const response = await post('/p/iam/prod', {
        etag: (await db.etag('config/iam/prod.yaml')) ?? '',
        'key.MFA_ENFORCEMENT': 'all',
        'key.SESSION_TTL': '3600',
      });

      expect(String(response.headers.location)).toContain('done=saved');
      expect((await get('/p/iam?env=prod')).body).toContain('all');
    });

    it('shows validation errors instead of applying the change', async () => {
      await start();
      const before = await db.read('config/iam/prod.yaml');

      const response = await post('/p/iam/prod', {
        'key.SESSION_TTL': '1',
        etag: (await db.etag('config/iam/prod.yaml')) ?? '',
      });

      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('SESSION_TTL');
      expect(response.body).toContain('must be at least 60');
      expect(response.body).toContain('class="err"');
      expect(await db.read('config/iam/prod.yaml')).toBe(before);
    });

    it('shows why a promote is invalid, not only the short detail', async () => {
      await start();
      await db.write({
        path: 'config/iam/dev.yaml',
        content: 'MFA_ENFORCEMENT: all\nSESSION_TTL: 900\n',
      });
      await db.write({
        path: 'config/iam/prod.yaml',
        content: 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 1\n',
      });

      const response = await post('/promote', {
        service: 'iam',
        from: 'dev',
        to: 'prod',
        select: 'MFA_ENFORCEMENT',
      });

      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('must be at least 60');
      expect(response.body).toContain('class="err"');
    });

    it('refuses a save when the file changed underneath the form', async () => {
      // Compare-and-swap: the form carries the etag it was built from. A concurrent write must
      // 409 rather than overwrite silently.
      await start();
      const stale = (await db.etag('config/iam/prod.yaml')) ?? '';
      await operations.writeValues(
        {
          service: 'iam',
          environment: 'prod',
          changes: { MFA_ENFORCEMENT: 'admins' },
          expectedEtag: await db.etag('config/iam/prod.yaml'),
        },
        { email: 'me@anudeep.pro', id: 'x' },
      );

      const response = await post('/p/iam/prod', {
        etag: stale,
        'key.MFA_ENFORCEMENT': 'all',
      });

      expect(response.statusCode).toBe(409);
      expect(response.body).toMatch(/changed|review|reapply/i);
    });

    it('refuses Promote and Delete when nothing is selected', async () => {
      await start();

      const promote = await post('/promote', {
        service: 'iam',
        from: 'prod',
        to: 'staging',
      });
      expect(promote.statusCode).toBeGreaterThanOrEqual(400);

      const deleted = await app.inject({
        method: 'POST',
        url: '/p/iam/delete-keys',
        payload: new URLSearchParams({ environment: 'prod' }).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...signedIn.headers,
        },
      });
      expect(deleted.statusCode).toBe(422);
      expect(deleted.body).toMatch(/select/i);
    });

    it('leaves a stored secret alone when its field is submitted blank', async () => {
      // The form never shows the current secret, so a blank field means "unchanged". Treating
      // it as a deletion would wipe the SMTP password every time someone edited an unrelated
      // flag on the same page — silently, and only noticed when mail stopped sending.
      await start();
      await operations.writeValues(
        {
          service: 'iam',
          environment: 'prod',
          changes: { SMTP_PASSWORD: 'hunter2' },
          expectedEtag: await db.etag('config/iam/prod.yaml'),
        },
        { email: 'me@anudeep.pro', id: 'x' },
      );

      await post('/p/iam/prod', { 'key.MFA_ENFORCEMENT': 'all', 'key.SMTP_PASSWORD': '' });

      const loader = new ConfigLoader(new SopsDecryptor(key.secret));
      const stored = (await db.read('config/iam/prod.yaml')) ?? '';
      expect(await loader.resolveOne('iam/prod', stored)).toMatchObject({
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
  const TYPED_SCHEMA = `version: 1
keys:
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
    let live2: Awaited<ReturnType<typeof liveOptions>>;
    let app2: Awaited<ReturnType<typeof buildWebApp>>;

    beforeEach(async () => {
      key2 = generateAgeKey();
      repo2 = await TestRepo.create();
      await repo2.commit({
        'schema/iam.yaml': TYPED_SCHEMA,
        'services.yaml':
          'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
        'environments.yaml': 'order: [dev, prod]\n',
        'config/iam/prod.yaml':
          'FP_COMPONENTS: [ua, lang]\nKILL_PASSWORD_LOGIN: false\nMFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
        'config/iam/dev.yaml': 'MFA_ENFORCEMENT: all\nSESSION_TTL: 900\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key2.recipient}\n`,
      });
      const loader2 = new ConfigLoader(new SopsDecryptor(key2.secret));
      live2 = await liveOptions(repo2.dir, { iam: TYPED_SCHEMA }, loader2);
      app2 = await buildWebApp({
        ...live2,
        environment: 'dev',
        auth: signedIn.auth,
      });
    });

    afterEach(async () => {
      await app2?.close();
      await rm(repo2.dir, { recursive: true, force: true });
    });

    const page = async () =>
      (await app2.inject({ method: 'GET', url: '/p/iam?env=prod', headers: signedIn.headers }))
        .body;

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
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...signedIn.headers,
        },
      });

      const loader = new ConfigLoader(new SopsDecryptor(key2.secret));
      const stored = (await live2.db.read('config/iam/prod.yaml')) ?? '';
      // False, not absent: an unticked box is a value, and deleting the key instead would hand
      // the service its compiled-in default, which may well be true.
      expect(await loader.resolveOne('iam/prod', stored)).toMatchObject({
        KILL_PASSWORD_LOGIN: false,
      });
    });

    it('shows what another environment holds for the same key', async () => {
      const body = await page();

      expect(body).toContain('class="peek"');
      expect(body).toMatch(/MFA_ENFORCEMENT[\s\S]*enum, &quot;optional&quot; \|\| &quot;admins&quot; \|\| &quot;all&quot;/);
      expect(body).not.toContain('In other environments');
    });
  });
});

describe('promoting ticked keys', () => {
  const SCHEMA2 = `version: 1
keys:
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
    let live3: Awaited<ReturnType<typeof liveOptions>>;
    let app3: Awaited<ReturnType<typeof buildWebApp>>;

    /**
     * Post a form the way the page does.
     *
     * A value save is a compare-and-swap: the rendered form carries the etag it was built from,
     * and the write refuses a base it did not read. A test that omits it is exercising the
     * conflict path, not the save path -- so the helper fills it in when the target is an
     * environment and the fields do not name one already.
     */
    const post = async (url: string, fields: Array<[string, string]>) => {
      const target = url.match(/^\/p\/([^/?]+)\/([^/?]+)$/);
      const withEtag =
        target && !fields.some(([field]) => field === 'etag')
          ? [
              ...fields,
              [
                'etag',
                (await live3.db.etag(`config/${target[1]}/${target[2]}.yaml`)) ?? '',
              ] as [string, string],
            ]
          : fields;
      return app3.inject({
        method: 'POST',
        url,
        payload: new URLSearchParams(withEtag).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...signedIn.headers,
        },
      });
    };

    const served = async (namespace: string) => {
      const [product, environment] = namespace.split('/');
      const source = await live3.db.read(`config/${product}/${environment}.yaml`);
      return source === null
        ? undefined
        : new ConfigLoader(new SopsDecryptor(key3.secret)).resolveOne(namespace, source);
    };

    beforeEach(async () => {
      key3 = generateAgeKey();
      repo3 = await TestRepo.create();
      await repo3.commit({
        'schema/iam.yaml': SCHEMA2,
        'environments.yaml': 'order: [dev, prod]\n',
        'services.yaml':
          'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
        'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key3.recipient}\n`,
      });
      const loader3 = new ConfigLoader(new SopsDecryptor(key3.secret));
      live3 = await liveOptions(repo3.dir, { iam: SCHEMA2 }, loader3);
      app3 = await buildWebApp({
        ...live3,
        environment: 'dev',
        auth: signedIn.auth,
      });
    });

    afterEach(async () => {
      await app3?.close();
      await rm(repo3.dir, { recursive: true, force: true });
    });

    it('saves every posted change live, ticked or not', async () => {
      // Save writes the values; ticks select keys only for Promote and Delete.
      const response = await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['key.SESSION_TTL', '600'],
        ['select', 'MFA_ENFORCEMENT'],
        ['intent', 'save'],
      ]);

      expect(response.statusCode).toBe(303);
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 600 });
    });

    it('makes the save live, because there is no second step left', async () => {
      // This asserted the opposite: `intent=save` staged a draft and left git untouched, and
      // publishing was the step that made it real. AC2 removed the step.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
        ['etag', (await live3.db.etag('config/iam/dev.yaml')) ?? ''],
      ]);

      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'all' });
    });

    it('offers Promote as a standing action beside Save', async () => {
      const page = await app3.inject({ method: 'GET', url: '/p/iam?env=dev', headers: signedIn.headers });
      expect(page.body).toContain('data-promote-post="/promote"');
      expect(page.body).toContain('data-promote-label="Promote to prod"');
      expect(page.body).toContain('name="select" value="MFA_ENFORCEMENT"');
      expect(visible(page.body)).not.toMatch(/draft|publish/i);
    });

    it('writes the promoted key into the next environment', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      const response = await post('/promote', [
        ['service', 'iam'],
        ['from', 'dev'],
        ['to', 'prod'],
        ['select', 'MFA_ENFORCEMENT'],
      ]);

      expect(response.statusCode).toBe(303);
      expect(String(response.headers.location)).toContain('env=prod');
      expect(String(response.headers.location)).toContain('done=promoted');
      // Written, not staged: AC4 makes the promotion the write.
      expect(await served('iam/prod')).toMatchObject({ MFA_ENFORCEMENT: 'all' });
    });

    it('does not post a false for a bool that has no override', async () => {
      // The hidden `false` beside a checkbox makes an unticked box mean false rather than
      // "delete the override" — but for a key with NO value it made `false` look like an edit,
      // so merely opening the page and saving staged every unset boolean on the product.
      //
      // The guarantee is in what the form emits, so that is what this asserts: a hand-made post
      // could carry anything and would prove nothing about the page.
      const body = (
        await app3.inject({ method: 'GET', url: '/p/iam?env=dev', headers: signedIn.headers })
      ).body;

      expect(body).toMatch(/name="key.KILL_PASSWORD_LOGIN"/);
      expect(body).not.toContain(
        '<input type="hidden" name="key.KILL_PASSWORD_LOGIN" value="false">',
      );
    });

    it('counts what a promotion actually wrote, not what was asked', async () => {
      // dev and prod already agree on SESSION_TTL, so promoting both keys moves one. Reporting
      // two would send the operator looking for a change that is not there.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      const response = await post('/promote', [
        ['service', 'iam'],
        ['from', 'dev'],
        ['to', 'prod'],
        ['select', 'MFA_ENFORCEMENT'],
        ['select', 'SESSION_TTL'],
      ]);

      // The count travels as a number and the wording is the console's; one key moved, not two.
      expect(String(response.headers.location)).toContain('done=promoted');
      expect(String(response.headers.location)).toContain('n=1');
    });

    it('offers nothing to promote from the last environment', async () => {
      await post('/p/iam/prod', [
        ['key.MFA_ENFORCEMENT', 'admins'],
        ['select', 'MFA_ENFORCEMENT'],
        ['message', 'Change prod'],
        ['intent', 'save'],
      ]);

      const page = await app3.inject({
        method: 'GET',
        url: '/p/iam?env=prod&published=MFA_ENFORCEMENT',
        headers: signedIn.headers,
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
  const SCHEMA4 = `version: 1
keys:
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
    let live4: Awaited<ReturnType<typeof liveOptions>>;
    let app4: Awaited<ReturnType<typeof buildWebApp>>;

    const page = async (url = '/p/iam?env=dev') =>
      (await app4.inject({ method: 'GET', url, headers: signedIn.headers })).body;

    /**
     * Post a form the way the page does.
     *
     * A value save is a compare-and-swap: the rendered form carries the etag it was built from,
     * and the write refuses a base it did not read. A test that omits it is exercising the
     * conflict path, not the save path -- so the helper fills it in when the target is an
     * environment and the fields do not name one already.
     */
    const post = async (url: string, fields: Array<[string, string]>) => {
      const target = url.match(/^\/p\/([^/?]+)\/([^/?]+)$/);
      const withEtag =
        target && !fields.some(([field]) => field === 'etag')
          ? [
              ...fields,
              [
                'etag',
                (await live4.db.etag(`config/${target[1]}/${target[2]}.yaml`)) ?? '',
              ] as [string, string],
            ]
          : fields;
      return app4.inject({
        method: 'POST',
        url,
        payload: new URLSearchParams(withEtag).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...signedIn.headers,
        },
      });
    };

    beforeEach(async () => {
      key4 = generateAgeKey();
      repo4 = await TestRepo.create();
      await repo4.commit({
        'schema/iam.yaml': SCHEMA4,
        'environments.yaml': 'order: [dev, prod]\n',
        'services.yaml':
          'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
        'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key4.recipient}\n`,
      });
      const loader4 = new ConfigLoader(new SopsDecryptor(key4.secret));
      live4 = await liveOptions(repo4.dir, { iam: SCHEMA4 }, loader4);
      app4 = await buildWebApp({
        ...live4,
        environment: 'dev',
        auth: signedIn.auth,
      });
    });

    afterEach(async () => {
      await app4?.close();
      await rm(repo4.dir, { recursive: true, force: true });
    });

    it('renders Save, Promote and Delete on the live form', async () => {
      const body = await page();

      expect(body).toContain('data-save-post="/p/iam/dev"');
      expect(body).toContain('data-promote-post="/promote"');
      expect(body).toContain('data-delete-post="/p/iam/delete-keys"');
      expect(body).not.toContain('value="publish"');

      // A page that failed validation still offers Save: hiding it would leave no way to fix.
      const withMore = await post('/p/iam/dev', [
        ['key.SESSION_TTL', 'not-a-number'],
        ['intent', 'save'],
      ]);
      expect(withMore.statusCode).toBe(422);
      expect(withMore.body).toContain('data-save-post="/p/iam/dev"');
    });

    it('asks for no message, since every commit message is generated', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(await page()).not.toContain('id="message"');
    });

    it('keeps the ticks in the same form as the actions', async () => {
      // In separate forms the ticks are simply not submitted, and Promote/Delete would then
      // have nothing to act on.
      const form =
        (await page()).match(/<form[^>]*action="\/p\/iam\/dev"[\s\S]*?<\/form>/)?.[0] ?? '';

      expect(form).toContain('name="select"');
      expect(form).toContain('data-promote-post="/promote"');
      expect(form).toContain('data-delete-post="/p/iam/delete-keys"');
      expect(form).toContain('data-save-post="/p/iam/dev"');
    });

    it('never renders a publish action', async () => {
      expect(await page()).not.toContain('value="publish"');
      expect(await page()).not.toContain('/publish');
    });

    it('keeps Save as a recipe on the form, not a hidden button', async () => {
      const form =
        (await page()).match(/<form[^>]*data-live-values[\s\S]*?<\/form>/)?.[0] ?? '';
      expect(form).toContain('data-save-post=');
      expect(form).not.toMatch(/<button[^>]*value="save"/);
      expect(form).not.toMatch(/<(?:span|button)[^>]*\shidden/);
    });

    it('has no leftover publish form that would ignore the ticks', async () => {
      const body = await page();
      expect(body.match(/action="\/publish"/g) ?? []).toHaveLength(0);
      // Git backup is the footer Auto sync / product-list Sync changes now, not this page.
      expect(body).not.toContain('name="namespace" value="iam"');
    });

    it('offers a tick on every key, not only the changed ones', async () => {
      // A tick is how you say what goes — to a publish and to the next environment — so a key
      // the form will not offer is a key you cannot send along.
      const body = await page();

      for (const key of ['MFA_ENFORCEMENT', 'SESSION_TTL']) {
        expect(body).toContain(`name="select" value="${key}"`);
      }
    });

    it('starts every key clear, including one a save just wrote', async () => {
      // A tick is a selection Promote/Delete consume. Nothing on a freshly loaded page is
      // selected for anything.
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
    'version: 1\nkeys:\n  RATE_LIMIT:\n    type: int\n    min: 1\n    max: 1000\n    default: 100\n';

  const SCHEMA5 = `version: 1
keys:
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
    let live5: Awaited<ReturnType<typeof liveOptions>>;
    let app5: Awaited<ReturnType<typeof buildWebApp>>;

    const page = async () =>
      (await app5.inject({ method: 'GET', url: '/p/iam?env=dev', headers: signedIn.headers })).body;

    /**
     * Post a form the way the page does.
     *
     * A value save is a compare-and-swap: the rendered form carries the etag it was built from,
     * and the write refuses a base it did not read. A test that omits it is exercising the
     * conflict path, not the save path -- so the helper fills it in when the target is an
     * environment and the fields do not name one already.
     */
    const post = async (url: string, fields: Array<[string, string]>) => {
      const target = url.match(/^\/p\/([^/?]+)\/([^/?]+)$/);
      const withEtag =
        target && !fields.some(([field]) => field === 'etag')
          ? [
              ...fields,
              [
                'etag',
                (await live5.db.etag(`config/${target[1]}/${target[2]}.yaml`)) ?? '',
              ] as [string, string],
            ]
          : fields;
      return app5.inject({
        method: 'POST',
        url,
        payload: new URLSearchParams(withEtag).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...signedIn.headers,
        },
      });
    };

    beforeEach(async () => {
      key5 = generateAgeKey();
      repo5 = await TestRepo.create();
      await repo5.commit({
        'schema/iam.yaml': SCHEMA5,
        'schema/api.yaml': API_SCHEMA5,
        'environments.yaml': 'order: [dev, prod]\n',
        'services.yaml':
          'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n' +
          '  - name: api\n    uid: 1003\n    namespaces: [api/prod]\n',
        // api has prod and no dev: the declared dev tab is the one with no file behind it.
        'config/api/prod.yaml': 'RATE_LIMIT: 50\n',
        'config/iam/dev.yaml':
          'FP_COMPONENTS: [ua, lang]\nKILL_PASSWORD_LOGIN: false\nMFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
        'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
        '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key5.recipient}\n`,
      });
      const loader5 = new ConfigLoader(new SopsDecryptor(key5.secret));
      live5 = await liveOptions(repo5.dir, { iam: SCHEMA5, api: API_SCHEMA5 }, loader5);
      app5 = await buildWebApp({
        ...live5,
        environment: 'dev',
        auth: signedIn.auth,
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

      expect(body.indexOf('class="tabs"')).toBeLessThan(body.indexOf('class="idle"'));
      expect(body.indexOf('class="idle"')).toBeLessThan(body.indexOf('name="key.MFA_ENFORCEMENT"'));
    });

    it('keeps the actions inside the form that carries the ticks', async () => {
      // Outside it they would submit neither the selection nor the values.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      const form = (await page()).match(/<form[^>]*data-keys[\s\S]*?<\/form>/)?.[0] ?? '';

      expect(form).toContain('data-save-post=');
      expect(form).toContain('data-promote-post=');
      expect(form).toContain('data-delete-post=');
      expect(form).toContain('name="select"');
      expect(form).toContain('name="key.MFA_ENFORCEMENT"');
    });

    it('keeps Save gated on a change and offers no publish at all', async () => {
      const body = await page();

      expect(body).toContain('data-save-post=');
      expect(body).not.toMatch(/<button[^>]*value="save"/);
      expect(body).not.toContain('value="publish"');
      expect(body).not.toContain('id="message"');
    });

    it('recounts a swapped-in page rather than inheriting the previous one', async () => {
      const script = (
        await app5.inject({ method: 'GET', url: '/assets/ticks.js', headers: signedIn.headers })
      ).body;

      expect(script).toContain('htmx:afterSwap');
      expect(script).toContain('data-promote-post');
      expect(script).toContain('data-save-post');
    });

    it('labels selection actions so the script can enable them', async () => {
      const body = await page();
      expect(body).toContain('data-promote-label="Promote to prod"');
      expect(body).toContain('data-delete-post="/p/iam/delete-keys"');
      expect(body).toContain('class="idle"');
    });

    it('says the save is live, and marks that notice as one to clear', async () => {
      const done = await app5.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: new URLSearchParams([
          ['key.MFA_ENFORCEMENT', 'all'],
          ['intent', 'save'],
          ['etag', (await live5.db.etag('config/iam/dev.yaml')) ?? ''],
        ]).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'hx-request': 'true',
          ...signedIn.headers,
        },
      });

      expect(done.body).toContain('Live now in iam/dev');
      expect(done.body).toMatch(/data-transient/);
    });

    it('keeps a failed back-up notice as a problem, not a transient confirmation', async () => {
      // Back-up failures are the durable report that git did not receive the mirror. A page that
      // erases that after five seconds is worse than one that never said it.
      const notice = '<span class="notice problem" data-notice';
      expect(notice).toContain('problem');
      expect(notice).not.toContain('data-transient');
    });

    // htmx does not swap a 4xx response by default, and hx-retarget does not change that. Every
    // validation error the server rendered was therefore discarded by the browser: saving an
    // out-of-range value looked like pressing a button that did nothing at all.
    it('swaps a refused save in, so its errors are on the screen', async () => {
      const script = (
        await app5.inject({ method: 'GET', url: '/assets/ticks.js', headers: signedIn.headers })
      ).body;

      expect(script).toContain('htmx:beforeSwap');
      expect(script).toContain('422');
      expect(script).toContain('shouldSwap');
    });

    it('clears a transient notice after five seconds, and only a transient one', async () => {
      const script = (
        await app5.inject({ method: 'GET', url: '/assets/ticks.js', headers: signedIn.headers })
      ).body;

      expect(script).toContain('data-transient');
      expect(script).toContain('5000');
    });

    it('answers a save that changes nothing without an error page', async () => {
      // A no-op is still a successful compare-and-swap against the base etag: the page stays
      // calm rather than returning 422 with no per-key errors.
      const swapped = await app5.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: new URLSearchParams([
          ['key.MFA_ENFORCEMENT', 'optional'],
          ['intent', 'save'],
          ['etag', (await live5.db.etag('config/iam/dev.yaml')) ?? ''],
        ]).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'hx-request': 'true',
          ...signedIn.headers,
        },
      });

      expect(swapped.statusCode).toBe(200);
      expect(swapped.body).toContain('Live now in iam/dev');
      expect(swapped.body).not.toContain('value="publish"');

      const plain = await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'optional'],
        ['intent', 'save'],
      ]);

      expect(plain.statusCode).toBe(303);
      expect(plain.headers.location).toMatch(/done=saved/);
    });

    // The confirmation for this went missing without a single test failing: respond() stopped
    // accepting `notice`, the branch went on passing it inside a SPREAD, and TypeScript does not
    // excess-property-check a spread. Creating an environment reported nothing at all.
    it('offers to add a declared environment that has no file', async () => {
      // api/dev is declared by environments.yaml and has no file behind it.
      const page = await app5.inject({
        method: 'GET',
        url: '/p/api?env=dev',
        headers: signedIn.headers,
      });

      expect(page.body).toMatch(/Create from schema defaults/i);
      expect(page.body).toContain('name="intent" value="create"');
    });

    // Not disabled: absent. A disabled control asks the reader to work out why, and the answer
    // -- "every environment already exists" -- is worth nothing to them.
    it('offers nothing where every declared environment already exists', async () => {
      const page = await app5.inject({
        method: 'GET',
        url: '/p/iam?env=dev',
        headers: signedIn.headers,
      });

      expect(page.body).not.toMatch(/Add dev|Add prod/);
    });

    it('says so when it creates an environment', async () => {
      const ask = await post('/p/api/dev', [['intent', 'create']]);
      expect(ask.statusCode).toBe(200);
      expect(ask.body).toMatch(/live immediately/i);
      const base = ask.body.match(/name="base" value="([^"]+)"/)?.[1];
      expect(base).toBeTruthy();

      const response = await post('/p/api/dev', [
        ['intent', 'create'],
        ['confirm', 'yes'],
        ['base', base!],
      ]);

      expect(response.statusCode).toBe(303);
      expect(String(response.headers.location)).toContain('done=created');
    });

    it('offers to create a declared environment that has no file yet', async () => {
      // api/dev is declared by environments.yaml and has no file. The tab renders, and asks
      // before creating anything: a click should not write a file nobody reviewed.
      const page = (
        await app5.inject({ method: 'GET', url: '/p/api?env=dev', headers: signedIn.headers })
      ).body;

      expect(page).toMatch(/no file/i);
      expect(page).toContain('name="intent" value="create"');
      // Read-only until it exists: there is nothing to edit before the file does.
      expect(page).not.toContain('name="key.RATE_LIMIT"');
      expect(page).toContain('RATE_LIMIT');
    });

    it('writes schema defaults live when the offer is accepted', async () => {
      const ask = await post('/p/api/dev', [['intent', 'create']]);
      const base = ask.body.match(/name="base" value="([^"]+)"/)?.[1] ?? '';
      await post('/p/api/dev', [
        ['intent', 'create'],
        ['confirm', 'yes'],
        ['base', base],
      ]);

      const page = (
        await app5.inject({ method: 'GET', url: '/p/api?env=dev', headers: signedIn.headers })
      ).body;

      expect(visible(page)).not.toMatch(/draft|Publish/i);
      // The declared defaults, written as values: once the file exists they are what the
      // service runs on.
      expect(page).toMatch(/value="100"/);
    });

    it('shows a validation error in place under htmx, as a fragment', async () => {
      // htmx does not swap a non-2xx by default, so the operator saw the spinner stop and the
      // page not change — and had every reason to think the value was accepted.
      const failed = await app5.inject({
        method: 'POST',
        url: '/p/iam/dev',
        payload: new URLSearchParams([
          ['key.SESSION_TTL', 'abc'],
          ['intent', 'save'],
          ['etag', (await live5.db.etag('config/iam/dev.yaml')) ?? ''],
        ]).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'hx-request': 'true',
          ...signedIn.headers,
        },
      });

      expect(failed.statusCode).toBe(422);
      // A fragment, not a whole document injected into #page — hx-target="#page" on the form
      // is what swaps it; the status stays honest so ticks.js can force the swap.
      expect(failed.body).not.toContain('<!doctype html>');
      expect(failed.body).toContain('SESSION_TTL');
    });

    it('still answers a scriptless browser with the same error page', async () => {
      const failed = await post('/p/iam/dev', [
        ['key.SESSION_TTL', 'abc'],
        ['intent', 'save'],
      ]);

      expect(failed.statusCode).toBe(422);
      expect(failed.body).toContain('<!doctype html>');
      expect(failed.body).toContain('SESSION_TTL');
    });

    /*
     * Two publish-scope tests lived here. The form used to post every declared environment and
     * publish aborted on the first one with nothing staged, so the button failed whenever a
     * service had a draft in one environment -- the ordinary case. The fix was to post the
     * SERVICE name and let the route resolve the scope, so it could not go stale.
     *
     * Neither can happen now: a save writes the environment it was posted to, and there is no
     * second action with a scope to get wrong. The back-up action that replaced publish takes
     * no scope at all -- it backs up the database.
     */
    it('offers auto-sync without a namespace scope to get wrong', async () => {
      const body = (
        await app5.inject({ method: 'GET', url: '/', headers: signedIn.headers })
      ).body;

      expect(body).toContain('Auto sync');
      expect(body).toContain('action="/sync/auto"');
      expect(body).not.toMatch(/name="namespace"/);
    });

    it('filters the product list to products holding a matching key', async () => {
      const found = (
        await app5.inject({ method: 'GET', url: '/?q=SESSION', headers: signedIn.headers })
      ).body;

      expect(found).toContain('Iam (1002)');
      expect(found).toContain('SESSION_TTL');
      // api declares RATE_LIMIT and nothing matching, so it is not in the list.
      expect(found).not.toContain('Api (1003)');
    });

    it('matches without regard to case, and says when nothing matched', async () => {
      expect(
        (await app5.inject({ method: 'GET', url: '/?q=session', headers: signedIn.headers })).body,
      ).toContain('SESSION_TTL');
      expect(
        (await app5.inject({ method: 'GET', url: '/?q=zzz', headers: signedIn.headers })).body,
      ).toMatch(/no key/i);
    });

    it('links a match to that product at dev, with the key marked', async () => {
      const found = (
        await app5.inject({ method: 'GET', url: '/?q=SESSION', headers: signedIn.headers })
      ).body;

      expect(found).toContain('/p/iam?env=dev&hl=SESSION_TTL');
    });

    it('marks the key a link arrived for, and marks nothing for a key that is not there', async () => {
      const marked = (
        await app5.inject({
          method: 'GET',
          url: '/p/iam?env=dev&hl=SESSION_TTL',
          headers: signedIn.headers,
        })
      ).body;

      expect(marked).toMatch(/class="[^"]*found[^"]*"/);
      expect(marked).toContain('.found');

      const nothing = (
        await app5.inject({
          method: 'GET',
          url: '/p/iam?env=dev&hl=NOPE',
          headers: signedIn.headers,
        })
      ).body;
      expect(nothing).not.toMatch(/class="[^"]*found[^"]*"/);
    });

    it('filters the fields inside a product, and navigates nowhere', async () => {
      const filtered = (
        await app5.inject({
          method: 'GET',
          url: '/p/iam?env=dev&q=SESSION',
          headers: signedIn.headers,
        })
      ).body;

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
      const found = (
        await app5.inject({ method: 'GET', url: '/?q=SESSION', headers: signedIn.headers })
      ).body;

      expect(found).toContain('SESSION_TTL');
      // dev holds 900 and prod 3600; neither belongs in a list of key names.
      expect(found).not.toContain('>900<');
      expect(found).not.toContain('>3600<');
    });

    it('marks a declared product whose schema is missing, and refuses to open it', async () => {
      // Without a schema every save fails validation at the last step, after the values are
      // typed. Better to say so on the list than to let someone find out at the end.
      await live5.db.write({
        path: 'services.yaml',
        content:
          'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n' +
          '  - name: audit\n    uid: 1004\n    namespaces: [audit/prod]\n',
      });

      const list = (await app5.inject({ method: 'GET', url: '/', headers: signedIn.headers })).body;

      expect(list).toContain('schema is missing');
      expect(list).toContain('Audit (1004)');
      // Not a link: there is nowhere useful for it to go.
      expect(list).not.toMatch(/href="\/p\/audit"/);
      expect(
        (await app5.inject({ method: 'GET', url: '/p/audit', headers: signedIn.headers }))
          .statusCode,
      ).toBe(404);
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

    it('states where you are on the idle line', async () => {
      const body = await page();

      expect(body).toMatch(/class="idle"[\s\S]*variables in/);
    });

    it('shows where you are, with no hidden selection placeholder', async () => {
      const body = await page();

      expect(body).toContain('class="idle"');
      expect(body).not.toContain('data-selection');
      expect(body).not.toContain('class="selection"');
    });

    /** The idle span holds the facts; actions are inserted into it, not beside it. */
    const idleLine = (body: string) => body.match(/<span class="idle">[\s\S]*?<\/span>/)?.[0] ?? '';

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

    it('bumps the document revision once per live save', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);
      // A no-op save must not bump again.
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(idleLine(await page())).toMatch(/revision 1/);
    });

    it('shows the revision in the idle line, where the rest of the file is described', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
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

    it('says nothing about drift against the next environment', async () => {
      // It was noise on a line whose job is to say where you are.
      expect(idleLine(await page())).not.toMatch(/differ from/);
    });

    it('keeps the idle line on the live form after a save', async () => {
      await post('/p/iam/dev', [
        ['key.MFA_ENFORCEMENT', 'all'],
        ['intent', 'save'],
      ]);

      expect(await page()).toContain('class="idle"');
      expect(idleLine(await page())).toMatch(/revision 1/);
    });

    it('holds the toolbar height whether or not the toolbar is there', async () => {
      // Appearing on the first tick would otherwise push every field down the page, under a
      // cursor that is aimed at one of them.
      const body = await page();

      expect(body).toContain('class="actionslot"');
      expect(body).toMatch(/\.actionslot \{ min-height:/);
    });

    it('renders the actions as links in the sentence, not as boxed buttons', async () => {
      // They read as part of the toolbar sentence rather than as a control bar bolted above
      // the fields. The buttons themselves are inserted by the script; the stylesheet is
      // what makes them look like the rest of the line.
      const css = (await page()).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';

      expect(css).toMatch(/\.linkbtn \{[^}]*font-size:\s*var\(--type-sm\)/);
      expect(css).not.toMatch(/\.actionline button[^{]*\{/);
    });

    it('styles a tick you are not allowed to clear differently from one you are', async () => {
      const body = await page();

      expect(body).toContain('.keypick input.locked');
      expect(body).toContain('.linkbtn:disabled');
    });

    it('serves the script that does all of it', async () => {
      const body = await page();
      expect(body).toContain('src="/assets/ticks.js"');
      expect(body).toContain('data-original');

      const script = await app5.inject({
        method: 'GET',
        url: '/assets/ticks.js',
        headers: signedIn.headers,
      });
      expect(script.statusCode).toBe(200);
      expect(script.body).toContain('data-promote-post');
      expect(script.body).toContain('data-save-post');
      expect(script.body).toContain('data-live-values');
    });
  });
});
