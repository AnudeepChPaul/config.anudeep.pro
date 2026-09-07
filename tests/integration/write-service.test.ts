import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitRepository } from '@config/src/git/repository.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, TestRepo } from '../helpers.js';

/**
 * The write path end to end: validate, check for a stale base, encrypt, commit.
 *
 * Against a real repository and real sops. The properties that matter here — that a secret is
 * ciphertext by the time it is committed, that a stale editor cannot overwrite someone else's
 * change, that a rejected save leaves no commit — are all properties of the interaction between
 * git, sops and the schema, so mocking any of them would test the mock.
 */

const withSops = hasSops() ? describe : describe.skip;

const SCHEMA = `keys:
  AUDIT_ENABLED:
    type: bool
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

withSops('ConfigWriteService', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let git: GitRepository;
  let service: ConfigWriteService;

  /** A repo whose .sops.yaml encrypts exactly the keys the schema marks secret. */
  const setUp = async (encryptedRegex = '^(SMTP_PASSWORD)$') => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "${encryptedRegex}"\n    age: ${key.recipient}\n`,
    });
    git = new GitRepository(repo.dir);
    service = new ConfigWriteService({
      repository: git,
      loader: new ConfigLoader(new SopsDecryptor(key.secret)),
      encryptor: new SopsEncryptor(repo.dir),
      schemas: () => SchemaSet.fromFiles({ iam: SCHEMA }),
    });
  };

  /** The committed file text, still encrypted — what a reviewer would see on GitHub. */
  const committed = async () => (await git.readSources()).sources.get('iam/prod') ?? '';

  /** The decrypted values, as a service would receive them. */
  const served = async () => {
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    return (await loader.resolve(await git.readSources())).namespaces.get('iam/prod');
  };

  const save = async (overrides: Record<string, unknown> = {}, base?: string) =>
    service.save(
      {
        service: 'iam',
        environment: 'prod',
        baseCommit: base ?? (await git.headCommit()),
        changes: { MFA_ENFORCEMENT: 'all', ...overrides },
        message: 'Tighten MFA after the login spike',
      },
      ACTOR,
      REQUEST,
    );

  beforeEach(async () => {
    await setUp();
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  describe('saving', () => {
    it('commits the change and reports the new commit', async () => {
      const before = await git.headCommit();

      const result = await save();

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.commit).not.toBe(before);
      expect(result.ok && result.value.commit).toBe(await git.headCommit());
    });

    it('serves the new value afterwards', async () => {
      await save();

      expect(await served()).toMatchObject({ MFA_ENFORCEMENT: 'all' });
    });

    it('leaves keys it was not asked to change alone', async () => {
      await save({ SESSION_TTL: 600 });

      await save({ MFA_ENFORCEMENT: 'admins' });

      expect(await served()).toMatchObject({ SESSION_TTL: 600, MFA_ENFORCEMENT: 'admins' });
    });

    it('removes a key set to undefined', async () => {
      // Deleting the override, not setting it to null — the value returns to the service's
      // compiled-in default.
      await save({ SESSION_TTL: 600 });

      await save({ SESSION_TTL: undefined });

      expect(await served()).not.toHaveProperty('SESSION_TTL');
    });

    it('writes keys in sorted order regardless of the order they were added', async () => {
      // git log is the audit trail; a file ordered by whenever each key happened to be set
      // would show unrelated keys moving on every save, hiding the one that actually changed.
      // AUDIT_ENABLED is added last and must still be written first.
      await save({ SESSION_TTL: 600 });

      await save({ AUDIT_ENABLED: true });

      const text = await committed();
      expect(text.indexOf('AUDIT_ENABLED')).toBeLessThan(text.indexOf('MFA_ENFORCEMENT'));
      expect(text.indexOf('MFA_ENFORCEMENT')).toBeLessThan(text.indexOf('SESSION_TTL'));
    });
  });

  describe('secrets', () => {
    it('encrypts a secret before committing it', async () => {
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(await committed()).toContain('ENC[AES256_GCM');
    });

    it('never commits the plaintext of a secret', async () => {
      // The repository is pushed to GitHub and cloned onto laptops. This is the assertion that
      // makes storing secrets in git defensible at all.
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(await committed()).not.toContain('hunter2');
    });

    it('round-trips the secret so services still receive it', async () => {
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(await served()).toMatchObject({ SMTP_PASSWORD: 'hunter2' });
    });

    it('leaves non-secret values readable in the committed file', async () => {
      // The premise of git-as-database: a reviewer can see what a flag changed to.
      await save();

      expect(await committed()).toContain('all');
    });

    it('refuses to commit when .sops.yaml would leave a schema secret in plaintext', async () => {
      // The schema marks a key secret; .sops.yaml decides what actually gets encrypted. If they
      // disagree in this direction the secret is committed in the clear, and neither file is
      // obviously wrong on its own.
      await setUp('^(NOTHING_MATCHES_THIS)$');
      const before = await git.headCommit();

      const result = await save({ SMTP_PASSWORD: 'hunter2' });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('secret_not_encrypted');
      expect(await git.headCommit()).toBe(before);
    });

    it('leaves no plaintext anywhere in the working tree', async () => {
      // The plaintext goes to a private temp directory, is encrypted, and the directory is
      // removed. A crash-free path must leave nothing readable in the volume holding the clone.
      await save({ SMTP_PASSWORD: 'hunter2' });

      const entries = await readdir(repo.dir, { recursive: true, withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile());
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const contents = await readFile(join(file.parentPath, file.name), 'utf8').catch(() => '');
        expect(contents).not.toContain('hunter2');
      }
    });
  });

  describe('the stale-commit check', () => {
    it('rejects a save whose base commit is behind HEAD', async () => {
      // Git's only concurrency control here. Without it the second editor silently discards the
      // first's change, and the audit trail shows a clean commit either way.
      const stale = await git.headCommit();
      await save({ SESSION_TTL: 600 });

      const result = await save({ MFA_ENFORCEMENT: 'admins' }, stale);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('conflict');
    });

    it('makes no commit when it rejects a stale save', async () => {
      const stale = await git.headCommit();
      await save({ SESSION_TTL: 600 });
      const head = await git.headCommit();

      await save({ MFA_ENFORCEMENT: 'admins' }, stale);

      expect(await git.headCommit()).toBe(head);
    });

    it('reports the commit the editor should reload from', async () => {
      const stale = await git.headCommit();
      await save({ SESSION_TTL: 600 });

      const result = await save({ MFA_ENFORCEMENT: 'admins' }, stale);

      expect(!result.ok && result.error.currentCommit).toBe(await git.headCommit());
    });

    it('accepts a save based on the current HEAD', async () => {
      await save({ SESSION_TTL: 600 });

      await expect(save({ MFA_ENFORCEMENT: 'admins' })).resolves.toMatchObject({ ok: true });
    });
  });

  describe('validation', () => {
    it('rejects a value the schema does not allow', async () => {
      const result = await save({ MFA_ENFORCEMENT: 'everyone' });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('invalid');
    });

    it('makes no commit when validation fails', async () => {
      const before = await git.headCommit();

      await save({ MFA_ENFORCEMENT: 'everyone' });

      expect(await git.headCommit()).toBe(before);
    });

    it('reports every problem at once', async () => {
      const result = await save({ MFA_ENFORCEMENT: 'everyone', SESSION_TTL: 1 });

      expect(!result.ok && result.error.errors?.map((e) => e.key).sort()).toEqual([
        'MFA_ENFORCEMENT',
        'SESSION_TTL',
      ]);
    });

    it('rejects a key the schema does not declare', async () => {
      const result = await save({ MFA_ENFORCMENT: 'all' });

      expect(result.ok).toBe(false);
    });
  });

  describe('the audit trail', () => {
    it('writes the operator message as the commit subject', async () => {
      await save();

      expect(await repo.git('log', '-1', '--format=%s')).toBe('Tighten MFA after the login spike');
    });

    it('records the actor and the request', async () => {
      await save();

      const body = await repo.git('log', '-1', '--format=%B');
      expect(body).toContain('Actor: me@anudeep.pro');
      expect(body).toContain('Request-Id: 01JQZX');
      expect(body).toContain('Source-IP: 203.0.113.7');
    });

    it('records the key that changed and hashes of its values', async () => {
      await save();

      const body = await repo.git('log', '-1', '--format=%B');
      expect(body).toContain('Key: MFA_ENFORCEMENT');
      expect(body).toMatch(/Old-Value-Hash: sha256:[0-9a-f]{64}/);
      expect(body).toMatch(/New-Value-Hash: sha256:[0-9a-f]{64}/);
    });

    it('never puts a secret value in the commit message', async () => {
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(await repo.git('log', '-1', '--format=%B')).not.toContain('hunter2');
    });
  });

  describe('serialisation between concurrent saves', () => {
    it('applies one and rejects the other as stale rather than losing a change', async () => {
      // Both editors loaded the same HEAD. The lock makes them run in turn; the stale check
      // then catches the second, which would otherwise silently overwrite the first.
      const base = await git.headCommit();

      const [first, second] = await Promise.all([
        save({ SESSION_TTL: 600 }, base),
        save({ MFA_ENFORCEMENT: 'admins' }, base),
      ]);

      const outcomes = [first.ok, second.ok].sort();
      expect(outcomes).toEqual([false, true]);
    });
  });
});
