import { rm } from 'node:fs/promises';
import { buildWebApp } from '@config/src/app.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { DraftStore } from '@config/src/store/draft-store.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const SCHEMA = `version: 1
keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
`;

withSops('the settings page', () => {
  let key: AgeKeypair;
  let repo: TestRepo;

  const build = async (over: Record<string, unknown>) => {
    const git = new GitRepository(repo.dir);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const drafts = new DraftStore(`${repo.dir}/.drafts.json`);
    return buildWebApp({
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
