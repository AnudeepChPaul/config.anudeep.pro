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
 * Publishing a whole draft, and moving a published change to the next environment.
 *
 * A draft is the unit of publishing: everything in it ships together, and nothing is left
 * staged afterwards. The per-key narrowing this file used to cover was withdrawn when the
 * console started counting drafts rather than keys.
 */

const withSops = hasSops() ? describe : describe.skip;

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

  describe('a draft publishes whole', () => {
    // This file used to pin the opposite: ticking individual keys shipped only those and
    // re-staged the rest. That was withdrawn when the draft became the unit of publishing — a
    // button counting drafts and an outcome shipping keys are two different things behind one
    // number. To hold a change back now, undo the change.
    it('commits every key in the draft', async () => {
      await stageBoth();

      const result = await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);

      expect(result.ok).toBe(true);
      expect(await served('iam/dev')).toMatchObject({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 600 });
    });

    it('leaves nothing staged behind', async () => {
      await stageBoth();

      await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);

      expect(await drafts.get('iam/dev')).toBeNull();
    });

    it('publishes a deletion, not just a new value', async () => {
      await service.stage(
        { service: 'iam', environment: 'dev', changes: { SESSION_TTL: undefined } },
        ACTOR,
      );

      await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);

      expect(await served('iam/dev')).not.toHaveProperty('SESSION_TTL');
    });

    it('carries a secret through as ciphertext', async () => {
      await service.stage(
        { service: 'iam', environment: 'dev', changes: { SMTP_PASSWORD: 'hunter2' } },
        ACTOR,
      );

      await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);

      const committed = (await git.readSources()).sources.get('iam/dev') ?? '';
      expect(committed).not.toContain('hunter2');
      expect(committed).toContain('ENC[AES256_GCM');
      expect(await served('iam/dev')).toMatchObject({ SMTP_PASSWORD: 'hunter2' });
    });

    it('names every published key in the commit trailers', async () => {
      await stageBoth();

      await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);
      const body = await repo.git('log', '-1', '--format=%B');

      expect(body).toContain('Key: MFA_ENFORCEMENT');
      expect(body).toContain('Key: SESSION_TTL');
    });
  });

  describe('promoting to the next environment', () => {
    it('stages the published value in the target', async () => {
      await service.stage(
        { service: 'iam', environment: 'dev', changes: { MFA_ENFORCEMENT: 'all' } },
        ACTOR,
      );
      await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);

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
      await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);

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
      await service.publish([{ namespace: 'iam/dev' }], ACTOR, REQUEST);

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
