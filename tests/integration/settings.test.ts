import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { EnvironmentOrder } from '@config/src/store/environment-order.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    return buildWebApp({
      ...(await liveOptions(repo.dir, { iam: retiringSchema('iam') }, loader)),
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
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const who = guarded();
    // The schema is where retiring lives, so a retiring fixture is a schema with the flag on.
    const schema = (over.retiring ?? []).includes('iam')
      ? `version: 1\nretiring: true\n${SCHEMA_KEYS}`
      : SCHEMA;
    const live = await liveOptions(repo.dir, { iam: schema }, loader);
    const app = await buildWebApp({
      ...live,
      environment: 'dev',
      auth: who.auth,
      ...(over.onCommitted ? { onCommitted: over.onCommitted } : {}),
    });
    // The database IS the registry now, so a test asserts what a write left there rather than
    // what it left staged.
    return { app, db: live.db, headers: who.headers };
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
    const { app, db, headers } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/p/new',
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    const registry = (await db.read('services.yaml')) ?? '';
    const schema = (await db.read('schema.yaml')) ?? '';
    await app.close();
    return { response, registry, schema };
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
    const { response, registry } = await post(audit([['name', 'new']]));

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatch(/reserved/);
    // Refused means nothing was written, not written-and-awaiting-a-publish.
    expect(registry).not.toMatch(/name: new\b/);
  });

  /**
   * A product that exists only in a draft.
   *
   * The list is built from services.yaml, and a product being CREATED is not in services.yaml
   * yet -- its entry is inside the draft. So its draft had no row to be counted against: the
   * page said "1 unpublished draft" and "nothing unpublished" in the same line, and offered no
   * way to publish the thing it had just been asked to create.
   */
  /**
   * A product is on the list the moment it is created.
   *
   * This used to be the awkward case: the list is built from services.yaml, and a product being
   * created was not in services.yaml yet -- its entry was inside the draft. So it had no row to
   * be counted against, and the page said "1 unpublished draft" and "nothing unpublished" in the
   * same line. Creating writes services.yaml now, so the product is simply there.
   */
  it('lists a product as soon as it is created, with nothing left to publish', async () => {
    const { app, headers } = await build();
    await app.inject({
      method: 'POST',
      url: '/p/new',
      payload: new URLSearchParams(audit()).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toContain('audit');
    // AC9: nothing may suggest the product is not yet in effect.
    expect(visible(page.body)).not.toMatch(/not published|publish|draft/i);
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

    expect(page.body).toMatch(/1 product retiring/);
    expect(page.body).toContain('/p/retiring');
    await app.close();
  });

  it('says nothing at all when none are retiring', async () => {
    const { app, headers } = await build({});

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).not.toMatch(/product retiring/);
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
  it('reloads what it serves as soon as a write lands, rather than waiting for a poll', async () => {
    // AC2/AC10: the write is live, so the cache is woken by the write itself. There is no
    // publish step left to wake it later.
    const reloads: number[] = [];
    const { app, headers } = await build({ onCommitted: () => reloads.push(Date.now()) });

    // Asking the question changes nothing, so nothing is reloaded for it.
    await app.inject({
      method: 'POST',
      url: '/p/iam/retire',
      payload: new URLSearchParams([['retiring', 'true']]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    expect(reloads.length, 'the confirmation alone changes no file').toBe(0);

    await retire(app, headers);

    expect(reloads.length, 'the write did').toBeGreaterThan(0);
    await app.close();
  });
  /**
   * Retirement, once it staged a draft.
   *
   * Marking a product retiring used to stage a draft, and until it was published the list said
   * nothing about it: the confirmation cleared itself after five seconds and what remained was
   * "2 drafts to publish", which does not say what they are. The act was invisible the moment
   * you looked away from it. A whole vocabulary grew around that gap -- a staged retirement wore
   * a different marker from a published one, because no consumer could see it yet.
   *
   * AC3 removed the gap: retirement is a schema write, so marking a product retiring IS the
   * change and every consumer sees it at once. The two markers collapse into one, and what is
   * left to assert is that the write happened, that the list says so, and that archiving still
   * refuses a product that is not retiring.
   */
  /**
   * Answer a confirmation the way the browser does.
   *
   * A destructive write asks first and renders a form carrying hidden fields -- among them the
   * base it read, so the write refuses if anything changed while the question was on screen.
   * Forging `confirm=yes` alone skips that field and gets a 409, so the helper posts the form
   * back rather than inventing it.
   */
  const confirmed = async (
    app: Awaited<ReturnType<typeof buildWebApp>>,
    headers: Record<string, string>,
    url: string,
    fields: Array<[string, string]> = [],
  ) => {
    const asked = await app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    const hidden: Array<[string, string]> = [
      ...asked.body.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g),
    ].map((match) => [match[1] as string, match[2] as string]);
    // A write that needed no confirmation has already happened; posting again must not say
    // something different from the first attempt, so the original fields travel with the answer.
    const answered = new Set(hidden.map(([field]) => field));
    return app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams([
        ...fields.filter(([field]) => !answered.has(field)),
        ...hidden,
        ['confirm', 'yes'],
      ]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
  };

  // Retiring asks first -- consumers see the mark immediately, so the console names that before
  // it writes.
  const retire = async (
    app: Awaited<ReturnType<typeof buildWebApp>>,
    headers: Record<string, string>,
    retiring = 'true',
  ) => confirmed(app, headers, '/p/iam/retire', [['retiring', retiring]]);

  it('marks a product retiring by writing the schema, not by staging anything', async () => {
    const { app, db, headers } = await build({});

    await retire(app, headers);

    expect(await db.read('schema.yaml')).toMatch(/retiring: true/);
    await app.close();
  });

  it('says nothing about publishing a retirement, because there is nothing to publish', async () => {
    const { app, headers } = await build({});

    await retire(app, headers);
    const page = await app.inject({ method: 'GET', url: '/', headers });

    // AC9: no wording may imply a change that has taken effect is still waiting.
    expect(visible(page.body)).not.toMatch(/publish/i);
    expect(visible(page.body)).not.toMatch(/draft/i);
    await app.close();
  });

  it('shows it as retiring on the list at once', async () => {
    const { app, headers } = await build({});

    await retire(app, headers);
    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toMatch(/retiring/);
    await app.close();
  });

  it('counts it in the retiring link, so marking one is visible at once', async () => {
    const { app, headers } = await build({});

    await retire(app, headers);
    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toMatch(/1 product retiring/);
    await app.close();
  });

  it('counts a product once, however many ways it is marked', async () => {
    const { app, headers } = await build({ retiring: ['iam'] });

    await retire(app, headers);
    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body.match(/product(s)? retiring/g)?.length ?? 0).toBe(1);
    await app.close();
  });

  it("does not list version among a product's keys", async () => {
    // `version` is the document's own field, not a key someone set.
    const { app, headers } = await build({});

    const page = await app.inject({ method: 'GET', url: '/p/iam?env=dev', headers });

    expect(page.body).toContain('MFA_ENFORCEMENT');
    expect(page.body).not.toMatch(/<label[^>]*>\s*version/i);
    await app.close();
  });

  it('keeps a retiring product in the product list', async () => {
    // Retiring is not archived: it is still served, and hiding it would make the thing you are
    // trying to wind down the one thing you cannot see.
    const { app, headers } = await build({ retiring: ['iam'] });

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toContain('iam');
    await app.close();
  });

  it('marks it as retiring in that list, rather than leaving it looking ordinary', async () => {
    const { app, headers } = await build({ retiring: ['iam'] });

    const page = await app.inject({ method: 'GET', url: '/', headers });

    expect(page.body).toMatch(/retiring/);
    await app.close();
  });

  it('lists them at /p/retiring, with what can be done to each', async () => {
    const { app, headers } = await build({ retiring: ['iam'] });

    const page = await app.inject({ method: 'GET', url: '/p/retiring', headers });

    expect(page.body).toContain('iam');
    expect(page.body).toMatch(/Archive/);
    expect(page.body).toMatch(/Cancel retirement/);
    await app.close();
  });

  it('takes a retirement back off again', async () => {
    const { app, db, headers } = await build({ retiring: ['iam'] });

    await retire(app, headers, 'false');

    expect(await db.read('schema.yaml')).not.toMatch(/retiring: true/);
    await app.close();
  });

  describe('archiving a retiring product', () => {
    // The database is the live tree now; git holds a backup of it. So these read what the
    // archive left in `db/`, which is where a consumer is served from.
    const archive = async () => {
      const { app, db, headers } = await build({ retiring: ['iam'] });
      const response = await confirmed(app, headers, '/p/iam/archive');
      await app.close();
      return { response, db };
    };

    it('takes the product out of the live tree', async () => {
      const { db } = await archive();

      expect(await db.read('schema.yaml')).not.toMatch(/MFA_ENFORCEMENT/);
      expect(await db.read('config/iam/dev.yaml')).toBeNull();
      expect(await db.read('services.yaml')).not.toMatch(/name: iam/);
    });

    it('writes one archive holding the grant, the schema and every environment', async () => {
      const { db } = await archive();
      const archived = parseYaml((await db.read('archived/iam.yaml')) ?? '');

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
      const encrypted = await new SopsEncryptor(repo.dir).encrypt(
        'iam/dev',
        'MFA_ENFORCEMENT: optional\n',
      );
      await repo.commit({ 'config/iam/dev.yaml': encrypted });
      expect(encrypted, 'the fixture is actually encrypted').toMatch(/^sops:/m);

      const { db } = await archive();
      const archived = parseYaml((await db.read('archived/iam.yaml')) ?? '');

      expect(archived.environments.dev).toBe(encrypted);
      // Not merely equal-ish: the envelope has to survive intact or the file cannot be decrypted.
      expect(String(archived.environments.dev)).toMatch(/^sops:/m);
    });

    it('refuses to archive a product that is not retiring', async () => {
      const { app, db, headers } = await build({});
      const response = await confirmed(app, headers, '/p/iam/archive');

      expect(response.statusCode).toBe(422);
      expect(await db.read('schema.yaml')).toMatch(/MFA_ENFORCEMENT/);
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

  /*
   * "Publishes a new product selected by name" lived here. It existed because the products
   * screen posted a NAME and the publish route had to resolve it to the environments worth
   * publishing -- and a product whose keys declare no defaults had none, so the publish went
   * quietly nowhere. There is no publish route to get wrong now: creating the product writes
   * every file it needs, which is what the next test asserts.
   */

  it('writes every file the product needs, in one transaction', async () => {
    // AC1: the schema entry and each environment file are written before services.yaml, so a
    // crash mid-write leaves a product that is invisible rather than one that is visible and
    // broken. What the test can see afterwards is that all of it landed.
    const { app, db, headers } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/p/new',
      payload: new URLSearchParams(audit()).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

    expect([200, 204, 303]).toContain(response.statusCode);
    expect(await db.read('services.yaml')).toMatch(/audit/);
    expect(await db.read('schema.yaml')).toMatch(/RETENTION_DAYS/);
    expect(await db.read('config/audit/dev.yaml')).not.toBeNull();
    expect(await db.read('config/audit/prod.yaml')).not.toBeNull();
    await app.close();
  });

  it('refuses a uid another service claims, and says which', async () => {
    const { response, registry } = await post(audit([['uid', '1002']]));

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatch(/iam/);
    expect(registry).not.toMatch(/audit/);
  });

  it('refuses a product with no environment chosen', async () => {
    const { response, registry } = await post(audit().filter(([field]) => field !== 'environment'));

    expect(response.statusCode).toBe(422);
    expect(registry).not.toMatch(/audit/);
  });

  it('refuses a uid that is not a whole number', async () => {
    expect((await post(audit([['uid', '-3']]))).response.statusCode).toBe(422);
    expect((await post(audit([['uid', '1.5']]))).response.statusCode).toBe(422);
    expect((await post(audit([['uid', '']]))).response.statusCode).toBe(422);
  });

  // The schema rules are the builder's, and they have to hold through the route too.
  it('refuses a default outside the bounds the same row declares', async () => {
    const { response, registry } = await post(audit([['key.0.default', '900']]));

    expect(response.statusCode).toBe(422);
    expect(registry).not.toMatch(/audit/);
  });

  it('gives the form back with what was typed still in it', async () => {
    const { response } = await post(audit([['uid', '1002']]));

    expect(response.body).toContain('value="audit"');
    expect(response.body).toContain('RETENTION_DAYS');
  });

  it('takes a bool default from the tick rather than from typed text', async () => {
    const { schema } = await post(
      audit([
        ['key.1.name', 'KILL_SWITCH'],
        ['key.1.type', 'bool'],
        ['key.1.defaultBool', 'true'],
      ]),
    );

    expect(schema).toMatch(/KILL_SWITCH:[\s\S]*?default: true/);
  });

  // An unticked checkbox is absent from the body, which is what "no default" means for every
  // other type too.
  it('declares a bool with no default when the box is not ticked', async () => {
    const { schema } = await post(
      audit([
        ['key.1.name', 'KILL_SWITCH'],
        ['key.1.type', 'bool'],
      ]),
    );

    expect(schema).toMatch(/KILL_SWITCH/);
    expect(schema).not.toMatch(/KILL_SWITCH:[\s\S]*?default:/);
  });

  it('declares a secret without a value', async () => {
    const { schema } = await post(
      audit([
        ['key.1.name', 'TOKEN'],
        ['key.1.type', 'string'],
        ['key.1.secret', '1'],
      ]),
    );

    expect(schema).toMatch(/secret: true/);
  });
});
