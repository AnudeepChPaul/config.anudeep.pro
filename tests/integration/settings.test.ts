import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { DraftStore } from '@config/src/store/draft-store.js';
import { EnvironmentOrder } from '@config/src/store/environment-order.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type AgeKeypair, generateAgeKey, guarded, hasSops, TestRepo } from '../helpers.js';

/**
 * Who may see how this service is configured.
 *
 * The page is a map of the deployment: which remote it pushes to, which key paths it reads, which
 * of its secrets are set. Two gates stand in front of it, and BOTH refuse with a 404 rather than a
 * 403 — a page that declines to answer still tells you it is there, and the existence of a
 * settings page is itself worth not disclosing.
 */
const withSops = hasSops() ? describe : describe.skip;

const SCHEMA_KEYS = `keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
`;
const SCHEMA = `version: 1\n${SCHEMA_KEYS}`;

withSops('the settings page', () => {
  let key: AgeKeypair;
  let repo: TestRepo;

  const build = async (over: Record<string, unknown> & { retiring?: readonly string[] } = {}) => {
    const retiringSchema = (name: string) =>
      (over.retiring ?? []).includes(name) ? `version: 1\nretiring: true\n${SCHEMA_KEYS}` : SCHEMA;
    const git = new GitRepository(repo.dir);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const drafts = new DraftStore(`${repo.dir}/.drafts.json`);
    return buildWebApp({
      repository: git,
      loader,
      schemas: () => SchemaSet.fromFiles({ iam: retiringSchema('iam') }),
      drafts,
      writeService: new ConfigWriteService({
        repository: git,
        loader,
        encryptor: new SopsEncryptor(repo.dir),
        schemas: () => SchemaSet.fromFiles({ iam: retiringSchema('iam') }),
        drafts,
      }),
      environment: 'dev',
      ...over,
    } as Parameters<typeof buildWebApp>[0]);
  };

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'environments.yaml': 'order: [dev, prod]\n',
      'services.yaml':
        'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev]\n',
      'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key.recipient}\n`,
    });
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  const asOperator = (email: string, via: 'iam' | 'break-glass') => {
    const session = guarded();
    return {
      auth: session.auth,
      headers: {
        cookie: session.auth.codec
          ? `config_session=${session.auth.codec.sign({ email, id: 'abc', via, expiresAt: Date.now() + 3_600_000 })}`
          : '',
      },
    };
  };

  it('does not exist when the toggle is off', async () => {
    const who = asOperator('me@anudeep.pro', 'break-glass');
    const app = await build({ auth: who.auth, settings: { enabled: false, allow: [] } });

    const response = await app.inject({ method: 'GET', url: '/settings', headers: who.headers });

    // 404, not 403: refusing to answer would confirm the page is there.
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('renders no link to itself when the toggle is off', async () => {
    const who = asOperator('me@anudeep.pro', 'break-glass');
    const app = await build({ auth: who.auth, settings: { enabled: false, allow: [] } });

    const page = await app.inject({ method: 'GET', url: '/', headers: who.headers });

    expect(page.body).not.toContain('/settings');
    await app.close();
  });

  it('links to itself from the footer for someone who may open it', async () => {
    const who = asOperator('ops@anudeep.pro', 'break-glass');
    const app = await build({ auth: who.auth, settings: { enabled: true, allow: [] } });

    const page = await app.inject({ method: 'GET', url: '/', headers: who.headers });

    expect(page.body).toContain('/settings');
    await app.close();
  });

  // The link and the gate answer the same question. If they ever disagree, the disagreement is a
  // link that leads to a 404 -- and a 404 that a link points at is a disclosure again.
  it('renders no link for someone the gate would refuse', async () => {
    const who = asOperator('someone@anudeep.pro', 'iam');
    const app = await build({
      auth: who.auth,
      settings: { enabled: true, allow: ['me@anudeep.pro'] },
    });

    const page = await app.inject({ method: 'GET', url: '/', headers: who.headers });

    expect(page.body).not.toContain('/settings');
    await app.close();
  });

  it('admits a break-glass session when the toggle is on', async () => {
    const who = asOperator('ops@anudeep.pro', 'break-glass');
    const app = await build({ auth: who.auth, settings: { enabled: true, allow: [] } });

    const response = await app.inject({ method: 'GET', url: '/settings', headers: who.headers });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('CONFIG_GIT_REMOTE');
    await app.close();
  });

  it('admits an allowlisted address', async () => {
    const who = asOperator('me@anudeep.pro', 'iam');
    const app = await build({
      auth: who.auth,
      settings: { enabled: true, allow: ['me@anudeep.pro'] },
    });

    expect(
      (await app.inject({ method: 'GET', url: '/settings', headers: who.headers })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('refuses an iam session that is not on the list, with a 404', async () => {
    const who = asOperator('someone@anudeep.pro', 'iam');
    const app = await build({
      auth: who.auth,
      settings: { enabled: true, allow: ['me@anudeep.pro'] },
    });

    expect(
      (await app.inject({ method: 'GET', url: '/settings', headers: who.headers })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('compares addresses without regard to case', async () => {
    const who = asOperator('Me@Anudeep.PRO', 'iam');
    const app = await build({
      auth: who.auth,
      settings: { enabled: true, allow: ['me@anudeep.pro'] },
    });

    expect(
      (await app.inject({ method: 'GET', url: '/settings', headers: who.headers })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('never puts a secret value in the page', async () => {
    const who = asOperator('ops@anudeep.pro', 'break-glass');
    const app = await build({ auth: who.auth, settings: { enabled: true, allow: [] } });

    const response = await app.inject({ method: 'GET', url: '/settings', headers: who.headers });

    // Whatever this process happens to be running with, none of it may be rendered whole.
    for (const name of ['CONFIG_AGE_KEY', 'CONFIG_SESSION_SECRET']) {
      const value = process.env[name];
      if (value) expect(response.body).not.toContain(value);
    }
    await app.close();
  });
});

/**
 * Declaring a product through the console.
 *
 * The form is a convenience; this is what actually decides. Every rule is asserted against a POST
 * body, because a hand-made request is exactly what the checks exist for.
 */
withSops('adding a product', () => {
  let key: AgeKeypair;
  let repo: TestRepo;

  const build = async (over: { retiring?: readonly string[]; onCommitted?: () => void } = {}) => {
    const git = new GitRepository(repo.dir);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const drafts = new DraftStore(`${repo.dir}/.drafts.json`);
    const who = guarded();
    // The schema is where retiring lives, so a retiring fixture is a schema with the flag on.
    const schemas = () =>
      SchemaSet.fromFiles({
        iam: (over.retiring ?? []).includes('iam')
          ? `version: 1\nretiring: true\n${SCHEMA_KEYS}`
          : SCHEMA,
      });
    const app = await buildWebApp({
      repository: git,
      loader,
      schemas,
      drafts,
      writeService: new ConfigWriteService({
        repository: git,
        loader,
        encryptor: new SopsEncryptor(repo.dir),
        schemas,
        drafts,
      }),
      environmentOrder: async () => EnvironmentOrder.fromYaml('order: [dev, prod]\n'),
      environment: 'dev',
      auth: who.auth,
      ...(over.onCommitted ? { onCommitted: over.onCommitted } : {}),
    });
    return { app, drafts, headers: who.headers };
  };

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'environments.yaml': 'order: [dev, prod]\n',
      'services.yaml':
        'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev]\n',
      'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(NOTHING)$"\n    age: ${key.recipient}\n`,
    });
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  const post = async (fields: Array<[string, string]>) => {
    const { app, drafts, headers } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/p/new',
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    const staged = await drafts.all();
    await app.close();
    return { response, staged };
  };

  // `over` REPLACES a field rather than appending one: a body carrying a field twice is a
  // different test from a body carrying the value under test, and appending would silently be
  // the former.
  const audit = (over: Array<[string, string]> = []): Array<[string, string]> => {
    const fields: Array<[string, string]> = [
      ['name', 'audit'],
      ['uid', '1004'],
      ['environment', 'dev'],
      ['environment', 'prod'],
      ['key.0.name', 'RETENTION_DAYS'],
      ['key.0.type', 'int'],
      ['key.0.min', '1'],
      ['key.0.max', '365'],
      ['key.0.default', '30'],
    ];
    const overridden = new Set(over.map(([field]) => field));
    return [...fields.filter(([field]) => !overridden.has(field)), ...over];
  };

  // A static segment beats a parameter in Fastify, so /p/new is the form and never a product.
  // A product called 'new' would therefore have a page nothing could reach.
  it("refuses a product called 'new', whose page could never be opened", async () => {
    const { response, staged } = await post(audit([['name', 'new']]));

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatch(/reserved/);
    expect(staged.length).toBe(0);
  });

  /**
   * A product that exists only in a draft.
   *
   * The list is built from services.yaml, and a product being CREATED is not in services.yaml
   * yet -- its entry is inside the draft. So its draft had no row to be counted against: the
   * page said "1 unpublished draft" and "nothing unpublished" in the same line, and offered no
   * way to publish the thing it had just been asked to create.
   */
  it('lists a product that only a draft declares, and offers to publish it', async () => {
    const { app, headers } = await build();
    await app.inject({
      method: 'POST',
      url: '/p/new',
      payload: new URLSearchParams(audit()).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toContain('audit');
    expect(page.body).toMatch(/Publish selected drafts/);
    // And it says which it is: nothing about it is committed yet.
    expect(page.body).toMatch(/not published yet/i);
    await app.close();
  });

  it('does not claim there is nothing unpublished while a draft exists', async () => {
    const { app, headers } = await build();
    await app.inject({
      method: 'POST',
      url: '/p/new',
      payload: new URLSearchParams(audit()).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).not.toContain('nothing unpublished');
    await app.close();
  });

  /**
   * Retiring, in the console.
   *
   * The count beside the Products header is the only place a retiring product is visible without
   * going looking for it, which is the point: the interval between marking and archiving is
   * worth nothing if nobody remembers it is running.
   */
  it('says how many products are retiring, beside the header', async () => {
    const { app, headers } = await build({ retiring: ['iam'] });

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toMatch(/1 product in retiring state/);
    expect(page.body).toContain('/p/retiring');
    await app.close();
  });

  it('says nothing at all when none are retiring', async () => {
    const { app, headers } = await build({});

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).not.toMatch(/retiring state/);
    await app.close();
  });

  // A retiring product is still a product: it is served, editable, and its values may still
  // need one last change on the way out. Dropping it from the list would hide the thing the
  // marker exists to draw attention to.
  /**
   * Publishing has to refresh what the console is looking at.
   *
   * Values are read from git per request, so they appear immediately. The grant table and the
   * schemas are not: they live in RepositoryState, refreshed by a webhook or a sixty-second
   * poll. So publishing a retirement updated the file and changed nothing on screen — the marker
   * arrived a minute later, or when the container restarted, which reads as "it does not work".
   */
  it('reloads what it serves after publishing, rather than waiting for a poll', async () => {
    const reloads: number[] = [];
    const { app, headers } = await build({ onCommitted: () => reloads.push(Date.now()) });

    await app.inject({
      method: 'POST',
      url: '/p/iam/retire',
      payload: new URLSearchParams([['retiring', 'true']]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    expect(reloads.length, 'staging alone changes no file').toBe(0);

    await app.inject({
      method: 'POST',
      url: '/publish',
      payload: new URLSearchParams([['namespace', 'iam/dev']]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

    expect(reloads.length, 'publishing did').toBeGreaterThan(0);
    await app.close();
  });

  /**
   * A retirement that is only staged.
   *
   * Marking a product retiring stages a draft, and until it is published the list said nothing
   * about it: the confirmation cleared itself after five seconds and what remained was "2 drafts
   * to publish", which does not say what they are. The act was invisible the moment you looked
   * away from it.
   *
   * It cannot wear the same marker as a published retirement, because no consumer can see it
   * yet — that is the difference the two markers have to carry.
   */
  it('shows a staged retirement on the list, before it is published', async () => {
    const { app, headers } = await build({});

    await app.inject({
      method: 'POST',
      url: '/p/iam/retire',
      payload: new URLSearchParams([['retiring', 'true']]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toMatch(/retiring/);
    // Said differently from a published one: nothing has reached a consumer yet.
    expect(page.body).toMatch(/unpublished|not published|drafted/i);
    await app.close();
  });

  it('does not count a staged retirement among the products actually retiring', async () => {
    const { app, headers } = await build({});

    await app.inject({
      method: 'POST',
      url: '/p/iam/retire',
      payload: new URLSearchParams([['retiring', 'true']]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    const page = await app.inject({ method: 'GET', url: '/', headers });

    // The count is about what consumers can see, and they cannot see a draft.
    expect(page.body).not.toMatch(/product in retiring state/);
    await app.close();
  });

  it('keeps a retiring product in the product list', async () => {
    const { app, headers } = await build({ retiring: ['iam'] });

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toContain('iam');
    await app.close();
  });

  it('marks it as retiring in that list, rather than leaving it looking ordinary', async () => {
    const { app, headers } = await build({ retiring: ['iam'] });

    const page = await app.inject({ method: 'GET', url: '/', headers });
    const row = page.body.slice(page.body.indexOf('iam ('), page.body.indexOf('iam (') + 600);

    expect(row).toMatch(/retiring/);
    await app.close();
  });

  it('lists them at /p/retiring, with both ways out', async () => {
    const { app, headers } = await build({ retiring: ['iam'] });

    const page = await app.inject({ method: 'GET', url: '/p/retiring', headers });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('iam');
    expect(page.body).toMatch(/Bring back/);
    expect(page.body).toMatch(/Archive the Product/);
    await app.close();
  });

  it('marks a product retiring by staging a draft, not by writing', async () => {
    const { app, drafts, headers } = await build({});

    const response = await app.inject({
      method: 'POST',
      url: '/p/iam/retire',
      payload: new URLSearchParams([['retiring', 'true']]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

    expect([200, 204, 303]).toContain(response.statusCode);
    const staged = await drafts.all();
    expect(staged.length).toBe(1);
    expect(String(staged[0]?.files?.['schema/iam.yaml'])).toMatch(/retiring: true/);
    await app.close();
  });

  /**
   * Archiving.
   *
   * The one write in this console that does not pass through a draft: it commits immediately.
   * That is the operator's decision, and it is why the act is reachable only from the retiring
   * list and asks in the row before it goes.
   */
  describe('archiving a retiring product', () => {
    const archive = async () => {
      const { app, headers } = await build({ retiring: ['iam'] });
      const response = await app.inject({
        method: 'POST',
        url: '/p/iam/archive',
        payload: '',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      });
      await app.close();
      return response;
    };

    it('takes the product out of the live tree', async () => {
      await archive();
      const git = new GitRepository(repo.dir);

      await expect(git.readFile('schema/iam.yaml')).rejects.toThrow();
      await expect(git.readFile('config/iam/dev.yaml')).rejects.toThrow();
      expect(await git.readFile('services.yaml')).not.toMatch(/name: iam/);
    });

    it('writes one archive holding the grant, the schema and every environment', async () => {
      await archive();
      const archived = parseYaml(await new GitRepository(repo.dir).readFile('archived/iam.yaml'));

      expect(archived.service).toMatchObject({ name: 'iam', uid: 1002 });
      expect(String(archived.schema)).toMatch(/MFA_ENFORCEMENT/);
      expect(Object.keys(archived.environments)).toContain('dev');
      expect(archived.archived.by).toBeTruthy();
    });

    // The whole reason the environments are kept as literal blocks: each carries its own SOPS
    // envelope and its own MAC, and merging them would destroy both.
    // Against a REAL envelope. The fixture commits plain text, and a plain file has no sops
    // block to damage — so this test passed a mutation that stripped the envelope, which is the
    // one thing it exists to catch.
    it('keeps each environment byte-identical, envelope and all', async () => {
      const git = new GitRepository(repo.dir);
      const encrypted = await new SopsEncryptor(repo.dir).encrypt(
        'iam/dev',
        'MFA_ENFORCEMENT: optional\n',
      );
      await repo.commit({ 'config/iam/dev.yaml': encrypted });
      expect(encrypted, 'the fixture is actually encrypted').toMatch(/^sops:/m);

      const before = await git.readFile('config/iam/dev.yaml');
      await archive();
      const archived = parseYaml(await git.readFile('archived/iam.yaml'));

      expect(archived.environments.dev).toBe(before);
      // Not merely equal-ish: the envelope has to survive intact or the file cannot be decrypted.
      expect(String(archived.environments.dev)).toMatch(/^sops:/m);
    });

    it('refuses to archive a product that is not retiring', async () => {
      const { app, headers } = await build({});
      const response = await app.inject({
        method: 'POST',
        url: '/p/iam/archive',
        payload: '',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      });

      expect(response.statusCode).toBe(422);
      expect(await new GitRepository(repo.dir).readFile('schema/iam.yaml')).toBeTruthy();
      await app.close();
    });
  });

  it('offers the form, listing the declared environments', async () => {
    const { app, headers } = await build();
    const page = await app.inject({ method: 'GET', url: '/p/new', headers });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('value="dev"');
    expect(page.body).toContain('value="prod"');
    await app.close();
  });

  it('stages one draft holding every file the product needs', async () => {
    const { response, staged } = await post(audit());

    expect([204, 303]).toContain(response.statusCode);
    expect(staged.length).toBe(1);
    const paths = Object.keys(staged[0]?.files ?? {});
    expect(paths).toContain('services.yaml');
    expect(paths).toContain('schema/audit.yaml');
  });

  it('refuses a uid another service claims, and says which', async () => {
    const { response, staged } = await post(audit([['uid', '1002']]));

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatch(/iam/);
    expect(staged.length).toBe(0);
  });

  it('refuses a product with no environment chosen', async () => {
    const { response, staged } = await post(audit().filter(([field]) => field !== 'environment'));

    expect(response.statusCode).toBe(422);
    expect(staged.length).toBe(0);
  });

  it('refuses a uid that is not a whole number', async () => {
    expect((await post(audit([['uid', '-3']]))).response.statusCode).toBe(422);
    expect((await post(audit([['uid', '1.5']]))).response.statusCode).toBe(422);
    expect((await post(audit([['uid', '']]))).response.statusCode).toBe(422);
  });

  // The schema rules are the builder's, and they have to hold through the route too.
  it('refuses a default outside the bounds the same row declares', async () => {
    const { response, staged } = await post(audit([['key.0.default', '900']]));

    expect(response.statusCode).toBe(422);
    expect(staged.length).toBe(0);
  });

  it('gives the form back with what was typed still in it', async () => {
    const { response } = await post(audit([['uid', '1002']]));

    expect(response.body).toContain('value="audit"');
    expect(response.body).toContain('RETENTION_DAYS');
  });

  it('takes a bool default from the tick rather than from typed text', async () => {
    const { staged } = await post(
      audit([
        ['key.1.name', 'KILL_SWITCH'],
        ['key.1.type', 'bool'],
        ['key.1.defaultBool', 'true'],
      ]),
    );

    const schema = String(staged[0]?.files?.['schema/audit.yaml']);
    expect(schema).toMatch(/KILL_SWITCH:[\s\S]*?default: true/);
  });

  // An unticked checkbox is absent from the body, which is what "no default" means for every
  // other type too.
  it('declares a bool with no default when the box is not ticked', async () => {
    const { staged } = await post(
      audit([
        ['key.1.name', 'KILL_SWITCH'],
        ['key.1.type', 'bool'],
      ]),
    );

    const schema = String(staged[0]?.files?.['schema/audit.yaml']);
    expect(schema).toMatch(/KILL_SWITCH/);
    expect(schema).not.toMatch(/KILL_SWITCH:[\s\S]*?default:/);
  });

  it('declares a secret without a value', async () => {
    const { staged } = await post(
      audit([
        ['key.1.name', 'TOKEN'],
        ['key.1.type', 'string'],
        ['key.1.secret', '1'],
      ]),
    );

    const schema = String(staged[0]?.files?.['schema/audit.yaml']);
    expect(schema).toMatch(/secret: true/);
    expect(staged[0]?.document).not.toMatch(/^TOKEN:/m);
  });
});
