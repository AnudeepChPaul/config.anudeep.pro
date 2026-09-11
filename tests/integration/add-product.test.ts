import { rm } from 'node:fs/promises';
import { SchemaSet } from '@config/src/schema/validator.js';
import type { DBEngine } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import type { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type AgeKeypair, generateAgeKey, hasSops, liveOptions, TestRepo } from '../helpers.js';

/**
 * Declaring a product from the console.
 *
 * A product is three kinds of file at once: an entry in services.yaml, which is the grant table;
 * a schema, without which the console refuses to render a page at all; and one environment file
 * per environment it is declared in. They are written in ONE transaction, because a registry
 * entry without its schema is a product nobody can open, and a schema without its entry is a
 * file nothing reads. Writing them separately would leave the registry in either of those
 * states -- and AC1 fixes the ORDER too: services.yaml goes last, so an interrupted create
 * leaves a product that is invisible rather than one that is visible and broken.
 *
 * The environment file it creates has to validate against a schema that exists only inside the
 * draft — the whole point is that the schema is not committed yet.
 */
const IAM_SCHEMA = `version: 1
keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, all]
`;

const SERVICES = `version: 1
services:
  - name: iam
    uid: 1002
    namespaces: [iam/prod]
`;

const ACTOR = { email: 'me@anudeep.pro', id: '7f3a1c9e' };
const REQUEST = { id: '01JQZX', sourceIp: '203.0.113.7' };

const withSops = hasSops() ? describe : describe.skip;

withSops('adding a product', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let db: DBEngine;
  let service: ConfigWriteService;

  const NEW_SCHEMA = `version: 1
keys:
  RETENTION_DAYS:
    type: int
    min: 1
    max: 365
    default: 30
  TOKEN:
    type: string
    secret: true
`;

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'services.yaml': SERVICES,
      'schema/iam.yaml': IAM_SCHEMA,
      'environments.yaml': 'order: [dev, prod]\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(TOKEN|SMTP_PASSWORD)$"\n    age: ${key.recipient}\n`,
    });
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const live = await liveOptions(repo.dir, { iam: IAM_SCHEMA }, loader);
    db = live.db;
    service = live.operations;
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  const addAudit = () =>
    service.createProduct(
      {
        service: 'audit',
        uid: 1004,
        environments: ['dev', 'prod'],
        schema: NEW_SCHEMA,
        defaults: { RETENTION_DAYS: 30 },
      },
      ACTOR,
    );

  /**
   * Retiring a product touches only its schema.
   *
   * Nothing about the values changes, so the namespace document must be left exactly as it was.
   * Rewriting it would bump the revision counter for a change nobody made, and that counter is
   * what a consumer uses to decide whether it is up to date — a false bump says "there is
   * something new here" about a file that is byte-identical.
   */
  describe('marking a product retiring', () => {
    const retire = (retiring: boolean) => service.setRetiring('iam', retiring, ACTOR);

    // A retirement used to be staged in its own draft under a reserved environment name, so
    // that publishing a value change could not ship a retirement nobody chose to publish. AC3
    // removed the staging: retiring IS a schema write. The separation it protected still holds,
    // because the schema and the environment files are different documents -- which is what
    // these assert.
    it('writes the schema flag and nothing else', async () => {
      const before = await db.read('config/iam/prod.yaml');

      expect((await retire(true)).ok).toBe(true);
      expect(await db.read('schema/iam.yaml')).toMatch(/retiring: true/);
      // Byte-identical: the revision counter did not move for a change nobody made.
      expect(await db.read('config/iam/prod.yaml')).toBe(before);
    });

    it('leaves a value save alone, and is left alone by one', async () => {
      await service.writeValues(
        { service: 'iam', environment: 'prod', changes: { MFA_ENFORCEMENT: 'all' } },
        ACTOR,
      );

      await retire(true);

      expect(await db.read('config/iam/prod.yaml')).toMatch(/MFA_ENFORCEMENT/);
      expect(await db.read('schema/iam.yaml')).toMatch(/retiring: true/);
    });

    it('takes the flag off again, which is how a retirement is cancelled', async () => {
      await retire(true);

      await retire(false);

      expect(await db.read('schema/iam.yaml')).not.toMatch(/retiring: true/);
    });

    it('changes nothing when it is asked for the state it is already in', async () => {
      // Reverting a retirement nobody made has nothing to undo. It used to leave a draft that
      // changed nothing and still had to be published to make the change nobody made go away.
      const before = await db.read('schema/iam.yaml');

      const reverted = await retire(false);

      expect(reverted.ok).toBe(true);
      expect(await db.read('schema/iam.yaml')).toBe(before);
    });

    it('refuses a product with no schema to mark', async () => {
      expect((await service.setRetiring('nothing', true, ACTOR)).ok).toBe(false);
    });
  });

  /**
   * A product whose keys declare no defaults.
   *
   * Its draft moves no key, because there is no value to move — and "moves no key" was the rule
   * publish used to decide a draft was about files rather than values. So the first
   * environment's file, which is the draft's own document, was never written: the product
   * arrived declared, schema and all, with one environment missing.
   */
  it('creates every environment file even when nothing has a default', async () => {
    const staged = await service.createProduct(
      {
        service: 'audit',
        uid: 1004,
        environments: ['dev', 'prod'],
        schema: 'version: 1\nkeys:\n  TOKEN:\n    type: string\n    secret: true\n',
        defaults: {},
      },
      ACTOR,
    );
    expect(staged.ok).toBe(true);

    expect(await db.read('config/audit/dev.yaml')).toBeTruthy();
    expect(await db.read('config/audit/prod.yaml')).toBeTruthy();
  });

  it('writes the registry entry, the schema and every environment file', async () => {
    const created = await addAudit();

    expect(created.ok).toBe(true);
    expect(await db.read('services.yaml')).toMatch(/audit/);
    expect(await db.read('schema/audit.yaml')).toMatch(/RETENTION_DAYS/);
    expect(await db.read('config/audit/dev.yaml')).toBeTruthy();
    expect(await db.read('config/audit/prod.yaml')).toBeTruthy();
  });

  it('advances the revision exactly once for the whole product', async () => {
    // AC1: all of it is one transaction, so a consumer sees the product appear in a single
    // step rather than watching it assemble itself file by file.
    const before = Number(await db.revision());

    await addAudit();

    expect(Number(await db.revision())).toBe(before + 1);
  });

  it('appends to the grant table rather than replacing it', async () => {
    await addAudit();
    const registry = parseYaml((await db.read('services.yaml')) ?? '') as {
      version: number;
      services: Array<{ name: string; uid: number; namespaces: string[] }>;
    };

    expect(registry.version).toBe(1);
    expect(registry.services.map((entry) => entry.name).sort()).toEqual(['audit', 'iam']);
    // The existing grant is untouched: adding a product must not widen or narrow another one.
    expect(registry.services.find((entry) => entry.name === 'iam')?.namespaces).toEqual([
      'iam/prod',
    ]);
    expect(registry.services.find((entry) => entry.name === 'audit')?.namespaces).toEqual([
      'audit/dev',
      'audit/prod',
    ]);
  });

  it('refuses a uid another service already claims, naming that service', async () => {
    const staged = await service.createProduct(
      { service: 'audit', uid: 1002, environments: ['dev'], schema: NEW_SCHEMA, defaults: {} },
      ACTOR,
    );

    expect(staged.ok).toBe(false);
    expect(!staged.ok && staged.error.detail).toMatch(/iam/);
  });

  it('refuses a name the registry already declares', async () => {
    const staged = await service.createProduct(
      { service: 'iam', uid: 9999, environments: ['dev'], schema: NEW_SCHEMA, defaults: {} },
      ACTOR,
    );

    expect(staged.ok).toBe(false);
    expect(!staged.ok && staged.error.detail).toMatch(/iam/);
  });

  it('refuses a product declared in no environment at all', async () => {
    const staged = await service.createProduct(
      { service: 'audit', uid: 1004, environments: [], schema: NEW_SCHEMA, defaults: {} },
      ACTOR,
    );

    expect(staged.ok).toBe(false);
  });

  it('writes the declared defaults into every environment file', async () => {
    await addAudit();

    expect(await db.read('config/audit/dev.yaml')).toContain('RETENTION_DAYS: 30');
    expect(await db.read('config/audit/prod.yaml')).toContain('RETENTION_DAYS: 30');
  });

  // A secret is declared and never given a value here; the product page is where secrets are
  // set and encrypted.
  it('leaves a declared secret unset', async () => {
    await addAudit();

    // Not a bare `toContain`: the sops metadata block names TOKEN in its encrypted_regex, which
    // is the file describing what it WOULD encrypt, not the key being set.
    const written = (await db.read('config/audit/dev.yaml')) ?? '';
    const values = written.split('\nsops:')[0] ?? '';
    expect(values).not.toMatch(/^TOKEN:/m);
  });

  it('leaves the new product readable by the console it was added from', async () => {
    await addAudit();

    expect(await db.read('services.yaml')).toContain('audit');
    expect(SchemaSet.fromFiles({ audit: (await db.read('schema/audit.yaml')) ?? '' }).has('audit')).toBe(
      true,
    );
  });
});
