import { rm } from 'node:fs/promises';
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
 * Publishing SOME of what is staged, and moving a published change to the next environment.
 *
 * The console lets an operator tick individual keys and publish just those — so a draft is no
 * longer all-or-nothing, and what is left behind has to stay correct relative to the commit that
 * just happened.
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

const ACTOR = { email: 'me@anudeep.pro', id: '7f3a1c9e' };
const REQUEST = { id: '01JQZX', sourceIp: '203.0.113.7' };

withSops('publishing part of a draft', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let git: GitRepository;
  let drafts: DraftStore;
  let service: ConfigWriteService;

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
      'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key.recipient}\n`,
    });
    git = new GitRepository(repo.dir);
    drafts = new DraftStore(`${repo.dir}/.drafts.json`);
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    service = new ConfigWriteService({
      repository: git,
      loader,
      encryptor: new SopsEncryptor(repo.dir),
      schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
      drafts,
    });
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  const served = async (namespace: string) => {
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    return (await loader.resolve(await git.readSources())).namespaces.get(namespace);
  };

  const stageBoth = async () => {
    await service.stage(
      { service: 'iam', environment: 'dev', changes: { MFA_ENFORCEMENT: 'all', SESSION_TTL: 600 } },
      ACTOR,
    );
  };

  describe('publishing a subset', () => {
    it('commits only the keys that were selected', async () => {
      await stageBoth();

      const result = await service.publish(
        [{ namespace: 'iam/dev', keys: ['MFA_ENFORCEMENT'] }],
        'Tighten MFA only',
        ACTOR,
        REQUEST,
      );

      expect(result.ok).toBe(true);
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 900 });
    });

    it('leaves the unselected key staged', async () => {
      await stageBoth();

      await service.publish(
        [{ namespace: 'iam/dev', keys: ['MFA_ENFORCEMENT'] }],
        'Part',
        ACTOR,
        REQUEST,
      );

      const draft = await drafts.get('iam/dev');
      expect(draft?.changes.map((c) => c.key)).toEqual(['SESSION_TTL']);
    });

    it('rebases what is left on the commit that just happened', async () => {
      // The residual draft was built against the old file. If it still carried the old base, the
      // next publish would either conflict or silently revert the key just published.
      await stageBoth();
      await service.publish(
        [{ namespace: 'iam/dev', keys: ['MFA_ENFORCEMENT'] }],
        'Part',
        ACTOR,
        REQUEST,
      );

      const rest = await service.publish(
        [{ namespace: 'iam/dev', keys: ['SESSION_TTL'] }],
        'Rest',
        ACTOR,
        REQUEST,
      );

      expect(rest.ok).toBe(true);
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 600 });
    });

    it('clears the draft when every staged key is selected', async () => {
      await stageBoth();

      await service.publish(
        [{ namespace: 'iam/dev', keys: ['MFA_ENFORCEMENT', 'SESSION_TTL'] }],
        'Both',
        ACTOR,
        REQUEST,
      );

      expect(await drafts.all()).toEqual([]);
    });

    it('publishes the whole draft when no keys are named', async () => {
      await stageBoth();

      await service.publish([{ namespace: 'iam/dev' }], 'Everything', ACTOR, REQUEST);

      expect(await drafts.all()).toEqual([]);
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 600 });
    });

    it('publishes a deletion, not just a new value', async () => {
      // Removing an override is a staged change like any other, and it is the one an incident
      // needs: drop a bad value and fall back to the service's compiled-in default. Treating a
      // staged key as always-a-value would leave the old one committed and report success.
      await service.stage(
        {
          service: 'iam',
          environment: 'dev',
          changes: { SESSION_TTL: undefined, MFA_ENFORCEMENT: 'all' },
        },
        ACTOR,
      );

      await service.publish(
        [{ namespace: 'iam/dev', keys: ['SESSION_TTL'] }],
        'Drop the override',
        ACTOR,
        REQUEST,
      );

      expect(await served('iam/dev')).not.toHaveProperty('SESSION_TTL');
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'optional' });
    });

    it('refuses a key that is not staged', async () => {
      await stageBoth();

      const result = await service.publish(
        [{ namespace: 'iam/dev', keys: ['SMTP_PASSWORD'] }],
        'Not staged',
        ACTOR,
        REQUEST,
      );

      expect(result.ok).toBe(false);
    });

    it('carries a secret through a partial publish', async () => {
      // The draft holds the secret encrypted, so publishing a subset has to decrypt it in memory
      // to rebuild the document. Getting this wrong loses the secret or commits it in the clear.
      await service.stage(
        {
          service: 'iam',
          environment: 'dev',
          changes: { SMTP_PASSWORD: 'hunter2', SESSION_TTL: 600 },
        },
        ACTOR,
      );

      await service.publish(
        [{ namespace: 'iam/dev', keys: ['SMTP_PASSWORD'] }],
        'Set password',
        ACTOR,
        REQUEST,
      );

      expect(await served('iam/dev')).toMatchObject({ SMTP_PASSWORD: 'hunter2' });
      const committed = (await git.readSources()).sources.get('iam/dev') ?? '';
      expect(committed).toContain('ENC[AES256_GCM');
      expect(committed).not.toContain('hunter2');
    });

    it('names only the published keys in the commit', async () => {
      await stageBoth();

      await service.publish(
        [{ namespace: 'iam/dev', keys: ['MFA_ENFORCEMENT'] }],
        'Part',
        ACTOR,
        REQUEST,
      );

      const body = await repo.git('log', '-1', '--format=%B');
      expect(body).toContain('Key: MFA_ENFORCEMENT');
      expect(body).not.toContain('Key: SESSION_TTL');
    });
  });

  describe('promoting to the next environment', () => {
    it('stages the published value in the target', async () => {
      await service.stage(
        { service: 'iam', environment: 'dev', changes: { MFA_ENFORCEMENT: 'all' } },
        ACTOR,
      );
      await service.publish(
        [{ namespace: 'iam/dev', keys: ['MFA_ENFORCEMENT'] }],
        'In dev',
        ACTOR,
        REQUEST,
      );

      const result = await service.promote(
        { service: 'iam', from: 'dev', to: 'prod', keys: ['MFA_ENFORCEMENT'] },
        ACTOR,
      );

      expect(result.ok).toBe(true);
      expect((await drafts.get('iam/prod'))?.changes.map((c) => c.key)).toEqual([
        'MFA_ENFORCEMENT',
      ]);
    });

    it('does not publish in the target', async () => {
      // Promotion and publishing stay two decisions; the target still gets reviewed.
      await service.stage(
        { service: 'iam', environment: 'dev', changes: { MFA_ENFORCEMENT: 'all' } },
        ACTOR,
      );
      await service.publish(
        [{ namespace: 'iam/dev', keys: ['MFA_ENFORCEMENT'] }],
        'In dev',
        ACTOR,
        REQUEST,
      );

      await service.promote(
        { service: 'iam', from: 'dev', to: 'prod', keys: ['MFA_ENFORCEMENT'] },
        ACTOR,
      );

      expect(await served('iam/prod')).toMatchObject({ MFA_ENFORCEMENT: 'optional' });
    });

    it('refuses to move a secret', async () => {
      // Each file is encrypted with its own data key, so the source ciphertext would not decrypt
      // in the target. Silently skipping it would leave the operator thinking it moved.
      await service.stage(
        { service: 'iam', environment: 'dev', changes: { SMTP_PASSWORD: 'hunter2' } },
        ACTOR,
      );
      await service.publish(
        [{ namespace: 'iam/dev', keys: ['SMTP_PASSWORD'] }],
        'Set',
        ACTOR,
        REQUEST,
      );

      const result = await service.promote(
        { service: 'iam', from: 'dev', to: 'prod', keys: ['SMTP_PASSWORD'] },
        ACTOR,
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.detail).toMatch(/secret/i);
    });

    it('refuses a key the source does not define', async () => {
      const result = await service.promote(
        { service: 'iam', from: 'dev', to: 'prod', keys: ['NOT_A_KEY'] },
        ACTOR,
      );

      expect(result.ok).toBe(false);
    });
  });
});
