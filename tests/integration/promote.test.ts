import { rm } from 'node:fs/promises';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import type { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, liveOptions, TestRepo } from '../helpers.js';

/**
 * Moving a value to the next environment.
 *
 * This file used to cover publishing part of a draft, and before that, ticking individual keys
 * so only those shipped. Both are gone: the draft was withdrawn as the unit of publishing when
 * the console started counting drafts rather than keys, and then the direct-write cutover
 * removed publishing altogether -- a save IS the change.
 *
 * Promotion survived all of it, because it is a different question from "when does this take
 * effect": it asks whether a value proven in one environment should be the value in the next.
 * It is a direct write now, so the two decisions it used to keep apart -- promote, then publish
 * -- have collapsed into the one that was always the real one.
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

withSops('promoting to the next environment', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let service: ConfigWriteService;
  let loader: ConfigLoader;

  beforeEach(async () => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'environments.yaml': 'order: [dev, prod]\n',
      'services.yaml':
        'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/dev, iam/prod]\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 3600\n',
      'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\nSESSION_TTL: 900\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "^(SMTP_PASSWORD)$"\n    age: ${key.recipient}\n`,
    });
    loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const live = await liveOptions(repo.dir, { iam: SCHEMA }, loader);
    service = live.operations;
    served = async (namespace: string) => {
      const [product, environment] = namespace.split('/');
      const source = await live.db.read(`config/${product}/${environment}.yaml`);
      return source === null ? undefined : loader.resolveOne(namespace, source);
    };
  });

  let served: (namespace: string) => Promise<Record<string, unknown> | undefined>;

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  /** Set a value in dev. It is live the moment it returns; there is nothing left to publish. */
  const setInDev = (changes: Record<string, unknown>) =>
    service.writeValues({ service: 'iam', environment: 'dev', changes }, ACTOR);

  it('writes the value straight into the target', async () => {
    await setInDev({ MFA_ENFORCEMENT: 'all' });

    const result = await service.promote(
      { service: 'iam', from: 'dev', to: 'prod', keys: ['MFA_ENFORCEMENT'] },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    // It used to stage a draft in the target and leave a second decision to make. AC4: the
    // promotion IS the write, so prod has the value as soon as this returns.
    expect(await served('iam/prod')).toMatchObject({ MFA_ENFORCEMENT: 'all' });
  });

  it('leaves the keys it was not asked to move alone', async () => {
    await setInDev({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 600 });

    await service.promote(
      { service: 'iam', from: 'dev', to: 'prod', keys: ['MFA_ENFORCEMENT'] },
      ACTOR,
    );

    expect(await served('iam/prod')).toMatchObject({
      MFA_ENFORCEMENT: 'all',
      SESSION_TTL: 3600,
    });
  });

  it('refuses to move a secret', async () => {
    // Each file is encrypted with its own data key, so the source ciphertext would not decrypt
    // in the target. Silently skipping it would leave the operator thinking it moved.
    await setInDev({ SMTP_PASSWORD: 'hunter2' });

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

  it('refuses a target that is not the next declared environment', async () => {
    // The order in environments.yaml is the promotion path; skipping a step is how a value
    // reaches prod without having been proven anywhere.
    const result = await service.promote(
      { service: 'iam', from: 'prod', to: 'dev', keys: ['MFA_ENFORCEMENT'] },
      ACTOR,
    );

    expect(result.ok).toBe(false);
  });
});
