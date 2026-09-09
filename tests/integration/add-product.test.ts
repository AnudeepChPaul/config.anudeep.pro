import { rm } from 'node:fs/promises';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { DraftStore } from '@config/src/store/draft-store.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type AgeKeypair, generateAgeKey, hasSops, TestRepo } from '../helpers.js';

/**
 * Declaring a product from the console.
 *
 * A product is three kinds of file at once: an entry in services.yaml, which is the grant table;
 * a schema, without which the console refuses to render a page at all; and one environment file
 * per environment it is declared in. They belong in ONE draft, because a registry entry without
 * its schema is a product nobody can open, and a schema without its entry is a file nothing
 * reads. Publishing them separately would leave the registry in either of those states.
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
  let git: GitRepository;
  let drafts: DraftStore;
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
    git = new GitRepository(repo.dir);
    drafts = new DraftStore(`${repo.dir}/.drafts.json`);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    service = new ConfigWriteService({
      repository: git,
      loader,
      encryptor: new SopsEncryptor(repo.dir),
      schemas: () => SchemaSet.fromFiles({ iam: IAM_SCHEMA }),
      drafts,
    });
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  const addAudit = () =>
    service.stageProduct(
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
    const retire = (retiring: boolean) =>
      service.stageSchemaFlag({ service: 'iam', retiring }, ACTOR);

    it('stages a draft rather than writing the schema', async () => {
      const before = await git.readFile('schema/iam.yaml');

      expect((await retire(true)).ok).toBe(true);
      expect(await git.readFile('schema/iam.yaml')).toBe(before);
      expect((await drafts.all()).length).toBe(1);
    });

    it('carries the schema with the flag set', async () => {
      await retire(true);
      const draft = (await drafts.all())[0];

      expect(String(draft?.files?.['schema/iam.yaml'])).toMatch(/retiring: true/);
    });

    it('publishes it without touching the values or their revision', async () => {
      const before = await git.readFile('config/iam/prod.yaml');
      await retire(true);
      await service.publish(['iam/prod'], ACTOR, REQUEST);

      expect(await git.readFile('schema/iam.yaml')).toMatch(/retiring: true/);
      // Byte-identical: the revision counter did not move for a change nobody made.
      expect(await git.readFile('config/iam/prod.yaml')).toBe(before);
    });

    it('takes the flag off again, which is how a retirement is cancelled', async () => {
      await retire(true);
      await service.publish(['iam/prod'], ACTOR, REQUEST);
      await retire(false);
      await service.publish(['iam/prod'], ACTOR, REQUEST);

      expect(await git.readFile('schema/iam.yaml')).not.toMatch(/retiring: true/);
    });

    it('refuses a product with no schema to mark', async () => {
      expect(
        (await service.stageSchemaFlag({ service: 'nothing', retiring: true }, ACTOR)).ok,
      ).toBe(false);
    });
  });

  it('stages one draft, not one per file', async () => {
    const staged = await addAudit();

    expect(staged.ok).toBe(true);
    expect((await drafts.all()).length).toBe(1);
  });

  it('carries the registry entry, the schema and every environment file', async () => {
    await addAudit();
    const draft = (await drafts.all())[0];
    const paths = Object.keys(draft?.files ?? {}).concat(`config/${draft?.namespace}.yaml`);

    expect(paths).toContain('services.yaml');
    expect(paths).toContain('schema/audit.yaml');
    expect(paths).toContain('config/audit/dev.yaml');
    expect(paths).toContain('config/audit/prod.yaml');
  });

  it('appends to the grant table rather than replacing it', async () => {
    await addAudit();
    const draft = (await drafts.all())[0];
    const registry = parseYaml(String(draft?.files?.['services.yaml'])) as {
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
    const staged = await service.stageProduct(
      { service: 'audit', uid: 1002, environments: ['dev'], schema: NEW_SCHEMA, defaults: {} },
      ACTOR,
    );

    expect(staged.ok).toBe(false);
    expect(!staged.ok && staged.error.detail).toMatch(/iam/);
  });

  it('refuses a name the registry already declares', async () => {
    const staged = await service.stageProduct(
      { service: 'iam', uid: 9999, environments: ['dev'], schema: NEW_SCHEMA, defaults: {} },
      ACTOR,
    );

    expect(staged.ok).toBe(false);
    expect(!staged.ok && staged.error.detail).toMatch(/iam/);
  });

  it('refuses a product declared in no environment at all', async () => {
    const staged = await service.stageProduct(
      { service: 'audit', uid: 1004, environments: [], schema: NEW_SCHEMA, defaults: {} },
      ACTOR,
    );

    expect(staged.ok).toBe(false);
  });

  // The point of the whole slice: publishing must land every file in one commit.
  it('publishes every file as a single commit', async () => {
    await addAudit();
    const published = await service.publish(['audit/dev'], ACTOR, REQUEST);

    expect(published.ok).toBe(true);
    // Every file is in the tree, and one commit put them there.
    expect(await git.readFile('schema/audit.yaml')).toContain('RETENTION_DAYS');
    expect(await git.readFile('config/audit/dev.yaml')).toBeTruthy();
    expect(await git.readFile('config/audit/prod.yaml')).toBeTruthy();
    // One commit added all of it: the root, the fixture, and this publish.
    const history = (await repo.git('log', '--oneline')).split('\n');
    expect(history.length).toBe(3);
  });

  it('writes the declared defaults into every environment file', async () => {
    await addAudit();
    await service.publish(['audit/dev'], ACTOR, REQUEST);

    const written = await git.readFile('config/audit/dev.yaml');
    expect(written).toContain('RETENTION_DAYS: 30');
  });

  // A secret is declared and never given a value here; writing one would put plaintext in a
  // draft snapshot, and the product page is where secrets are set and encrypted.
  it('leaves a declared secret unset', async () => {
    await addAudit();
    await service.publish(['audit/dev'], ACTOR, REQUEST);

    // Not a bare `toContain`: the sops metadata block names TOKEN in its encrypted_regex, which
    // is the file describing what it WOULD encrypt, not the key being set.
    const written = await git.readFile('config/audit/dev.yaml');
    const values = written.split('\nsops:')[0] ?? '';
    expect(values).not.toMatch(/^TOKEN:/m);
  });

  it('leaves the new product readable by the console it was added from', async () => {
    await addAudit();
    await service.publish(['audit/dev'], ACTOR, REQUEST);

    const registry = await git.readFile('services.yaml');
    expect(registry).toContain('audit');
    expect(
      SchemaSet.fromFiles({ audit: await git.readFile('schema/audit.yaml') }).has('audit'),
    ).toBe(true);
  });
});
