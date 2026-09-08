import { rm } from 'node:fs/promises';
import { validateRepository } from '@config/src/cli/validate-repo.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TestRepo } from '../helpers.js';

/**
 * The check that runs on every push to the config repository.
 *
 * Its defining constraint: **it must work without the age key.** CI is the least trusted place
 * the repository is ever cloned, and handing it the key to prove secrets are encrypted would
 * give away the thing being protected. So everything here is decided from ciphertext.
 */

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

const SERVICES = `services:
  - name: iam
    uid: 1002
    namespaces: [iam/prod]
`;

const CIPHERTEXT = 'ENC[AES256_GCM,data:x9Kd,iv:aa,tag:bb,type:str]';

const repos: string[] = [];

const repoWith = async (files: Record<string, string>) => {
  const repo = await TestRepo.create();
  repos.push(repo.dir);
  await repo.commit({ 'schema/iam.yaml': SCHEMA, 'services.yaml': SERVICES, ...files });
  return repo;
};

const messages = (findings: Array<{ file: string; message: string }>) =>
  findings.map((f) => `${f.file}: ${f.message}`).join('\n');

afterEach(async () => {
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('a repository that should pass', () => {
  it('accepts valid configuration', async () => {
    const repo = await repoWith({
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\nSESSION_TTL: 3600\n',
    });

    expect(await validateRepository(repo.dir)).toEqual([]);
  });

  it('accepts a namespace that overrides nothing', async () => {
    const repo = await repoWith({ 'config/iam/prod.yaml': '' });

    expect(await validateRepository(repo.dir)).toEqual([]);
  });

  it('accepts an encrypted secret without needing the key to read it', async () => {
    // The property the whole check is built around. No age key is available here, and none is
    // needed: a secret is proven encrypted by the shape of what was committed.
    const repo = await repoWith({
      'config/iam/prod.yaml': `MFA_ENFORCEMENT: all\nSMTP_PASSWORD: ${CIPHERTEXT}\nsops:\n  age: []\n`,
    });

    expect(await validateRepository(repo.dir)).toEqual([]);
  });
});

describe('secrets committed in the clear', () => {
  it('rejects a secret key holding a readable value', async () => {
    // The single most important assertion in this file. Without it, one save with SOPS
    // misconfigured publishes a password to GitHub and to every clone, permanently — history
    // keeps it even after the value is rotated.
    const repo = await repoWith({
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\nSMTP_PASSWORD: hunter2\n',
    });

    const findings = await validateRepository(repo.dir);

    expect(findings).not.toEqual([]);
    expect(messages(findings)).toMatch(/SMTP_PASSWORD/);
    expect(messages(findings)).toMatch(/encrypt/i);
  });

  it('does not repeat the plaintext it found in its own output', async () => {
    // CI logs are retained and often world-readable. A check that prints the secret it caught
    // has leaked it a second time, to a wider audience.
    const repo = await repoWith({
      'config/iam/prod.yaml': 'SMTP_PASSWORD: hunter2\n',
    });

    expect(messages(await validateRepository(repo.dir))).not.toContain('hunter2');
  });

  it('rejects ciphertext in a key the schema does not call secret', async () => {
    // The other direction of the same disagreement: either the schema is missing a secret flag
    // or .sops.yaml is encrypting too much. Both are worth stopping for.
    const repo = await repoWith({
      'config/iam/prod.yaml': `MFA_ENFORCEMENT: ${CIPHERTEXT}\n`,
    });

    expect(await validateRepository(repo.dir)).not.toEqual([]);
  });
});

describe('configuration that does not match its schema', () => {
  it('rejects a value outside the declared range', async () => {
    const repo = await repoWith({ 'config/iam/prod.yaml': 'SESSION_TTL: 1\n' });

    expect(messages(await validateRepository(repo.dir))).toMatch(/SESSION_TTL/);
  });

  it('rejects a key the schema does not declare', async () => {
    const repo = await repoWith({ 'config/iam/prod.yaml': 'MFA_ENFORCMENT: all\n' });

    expect(messages(await validateRepository(repo.dir))).toMatch(/MFA_ENFORCMENT/);
  });

  it('rejects a namespace with no schema at all', async () => {
    const repo = await repoWith({ 'config/ghost/prod.yaml': 'A: 1\n' });

    expect(messages(await validateRepository(repo.dir))).toMatch(/ghost/);
  });

  it('names the file each problem is in', async () => {
    const repo = await repoWith({ 'config/iam/prod.yaml': 'SESSION_TTL: 1\n' });

    expect((await validateRepository(repo.dir))[0]?.file).toBe('config/iam/prod.yaml');
  });

  it('reports every problem, not just the first', async () => {
    const repo = await repoWith({
      'config/iam/prod.yaml': 'SESSION_TTL: 1\nMFA_ENFORCEMENT: everyone\n',
    });

    expect((await validateRepository(repo.dir)).length).toBeGreaterThan(1);
  });

  it('keeps going after a broken file rather than stopping at it', async () => {
    // A push that breaks two files should report both, or fixing them takes two round trips.
    const repo = await repoWith({
      'config/iam/prod.yaml': 'SESSION_TTL: [unclosed\n',
      'config/iam/dev.yaml': 'SESSION_TTL: 1\n',
    });

    const files = new Set((await validateRepository(repo.dir)).map((f) => f.file));

    expect(files.has('config/iam/prod.yaml')).toBe(true);
    expect(files.has('config/iam/dev.yaml')).toBe(true);
  });
});

describe('the grant table', () => {
  it('rejects a services.yaml that cannot be loaded', async () => {
    const repo = await TestRepo.create();
    repos.push(repo.dir);
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'services.yaml': 'services:\n  - name: iam\n    uid: 1002\n    namespaces: []\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\n',
    });

    expect(messages(await validateRepository(repo.dir))).toMatch(/services\.yaml/);
  });

  it('rejects a grant for a namespace that does not exist', async () => {
    // A grant naming a namespace with no file is either a typo or a file someone deleted
    // without removing its grant. Both leave the table saying something untrue.
    const repo = await TestRepo.create();
    repos.push(repo.dir);
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'services.yaml': 'services:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/nowhere]\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\n',
    });

    expect(messages(await validateRepository(repo.dir))).toMatch(/iam\/nowhere/);
  });
});
