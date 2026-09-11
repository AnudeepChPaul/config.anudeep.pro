import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DBEngine, WriteEvent } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { SopsDecryptor } from '@config/src/store/sops.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, liveOptions, TestRepo } from '../helpers.js';

/**
 * The write path end to end: validate, check the base, encrypt, write.
 *
 * Against a real database and real sops. The properties that matter here -- that a secret is
 * ciphertext by the time it is stored, that a stale editor cannot overwrite someone else's
 * change, that a rejected save writes nothing -- are properties of the interaction between the
 * data engine, sops and the schema, so mocking any of them would test the mock.
 *
 * It used to commit, and these assertions read the git tree. The database is authoritative now
 * and git is a backup the sync engine writes on its own schedule, so the same properties are
 * asserted where the value actually lands. Pushing, and the commit message it carries, moved
 * with it: tests/unit/sync-engine.test.ts and tests/integration/data-engine-sync.test.ts own
 * that half.
 */

const withSops = hasSops() ? describe : describe.skip;

const SCHEMA = `version: 1
keys:
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
const PATH = 'config/iam/prod.yaml';

withSops('ConfigWriteService', () => {
  let key: AgeKeypair;
  let repo: TestRepo;
  let db: DBEngine;
  let service: ConfigWriteService;
  let written: WriteEvent[];

  /** A repo whose .sops.yaml encrypts exactly the keys the schema marks secret. */
  const setUp = async (encryptedRegex = '^(SMTP_PASSWORD)$') => {
    key = generateAgeKey();
    repo = await TestRepo.create();
    await repo.commit({
      'schema/iam.yaml': SCHEMA,
      'environments.yaml': 'order: [prod]\n',
      'services.yaml':
        'version: 1\nservices:\n  - name: iam\n    uid: 1002\n    namespaces: [iam/prod]\n',
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: optional\n',
      '.sops.yaml': `creation_rules:\n  - path_regex: config/.*\\.yaml$\n    encrypted_regex: "${encryptedRegex}"\n    age: ${key.recipient}\n`,
    });
    written = [];
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    const live = await liveOptions(repo.dir, { iam: SCHEMA }, loader, (event) =>
      written.push(event),
    );
    db = live.db;
    service = live.operations;
  };

  /** The stored file text, still encrypted -- what a backup would carry. */
  const stored = async () => (await db.read(PATH)) ?? '';

  /** The decrypted values, as a service would receive them. */
  const served = async () => {
    const loader = new ConfigLoader(new SopsDecryptor(key.secret));
    return loader.resolveOne('iam/prod', await stored());
  };

  /** The entity tag a save must be based on, which is what the console renders into the form. */
  const base = () => db.etag(PATH);

  const save = async (overrides: Record<string, unknown> = {}, expectedEtag?: string | null) =>
    service.writeValues(
      {
        service: 'iam',
        environment: 'prod',
        changes: { MFA_ENFORCEMENT: 'all', ...overrides },
        expectedEtag: expectedEtag === undefined ? await base() : expectedEtag,
      },
      ACTOR,
    );

  beforeEach(async () => {
    await setUp();
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  describe('saving', () => {
    it('writes the change and reports the revision it landed at', async () => {
      const before = await db.revision();

      const result = await save();

      expect(result.ok).toBe(true);
      expect(await db.revision()).not.toBe(before);
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

    it('refuses to remove a key through a value save', async () => {
      // This used to delete the override. AC5 gave removal its own operation, because taking a
      // key out means taking it out of the schema and every environment at once -- and doing
      // that as a side effect of one environment's Save is how a key came to be set somewhere
      // it was no longer declared.
      await save({ SESSION_TTL: 600 });

      const result = await save({ SESSION_TTL: undefined });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.detail).toMatch(/Delete/);
      expect(await served()).toMatchObject({ SESSION_TTL: 600 });
    });

    it('writes keys in sorted order regardless of the order they were added', async () => {
      // git log is the audit trail; a file ordered by whenever each key happened to be set
      // would show unrelated keys moving on every save, hiding the one that actually changed.
      // AUDIT_ENABLED is added last and must still be written first.
      await save({ SESSION_TTL: 600 });

      await save({ AUDIT_ENABLED: true });

      const text = await stored();
      expect(text.indexOf('AUDIT_ENABLED')).toBeLessThan(text.indexOf('MFA_ENFORCEMENT'));
      expect(text.indexOf('MFA_ENFORCEMENT')).toBeLessThan(text.indexOf('SESSION_TTL'));
    });
  });

  describe('secrets', () => {
    it('encrypts a secret before committing it', async () => {
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(await stored()).toContain('ENC[AES256_GCM');
    });

    it('never commits the plaintext of a secret', async () => {
      // The repository is pushed to GitHub and cloned onto laptops. This is the assertion that
      // makes storing secrets in git defensible at all.
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(await stored()).not.toContain('hunter2');
    });

    it('round-trips the secret so services still receive it', async () => {
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(await served()).toMatchObject({ SMTP_PASSWORD: 'hunter2' });
    });

    it('leaves non-secret values readable in the stored file', async () => {
      // The premise of the backup being reviewable: a reader can see what a flag changed to.
      await save();

      expect(await stored()).toContain('all');
    });

    it('refuses to commit when .sops.yaml would leave a schema secret in plaintext', async () => {
      // The schema marks a key secret; .sops.yaml decides what actually gets encrypted. If they
      // disagree in this direction the secret is committed in the clear, and neither file is
      // obviously wrong on its own.
      await setUp('^(NOTHING_MATCHES_THIS)$');
      const before = await stored();

      const result = await save({ SMTP_PASSWORD: 'hunter2' });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('secret_not_encrypted');
      expect(await stored()).toBe(before);
    });

    it('cannot encrypt from the database directory, which does not hold .sops.yaml', async () => {
      // The console pointed SopsEncryptor at CONFIG_DB_PATH. Rules live in the clone; the
      // database is values. That save returned "secret values were not encrypted: SMTP_PASSWORD".
      const broken = new ConfigWriteService({
        db,
        loader: new ConfigLoader(new SopsDecryptor(key.secret)),
        encryptor: new SopsEncryptor(join(repo.dir, '.test-db')),
      });
      const result = await broken.writeValues(
        { service: 'iam', environment: 'prod', changes: { SMTP_PASSWORD: 'hunter2' } },
        ACTOR,
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('secret_not_encrypted');
      expect(!result.ok && result.error.detail).toMatch(/SMTP_PASSWORD/);
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
    it('rejects a save whose base is behind the stored file', async () => {
      // The engine's concurrency control. Without it the second editor silently discards the
      // first's change, and the history shows a clean write either way.
      const stale = await base();
      await save({ SESSION_TTL: 600 });

      const result = await save({ MFA_ENFORCEMENT: 'admins' }, stale);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('conflict');
    });

    it('writes nothing when it rejects a stale save', async () => {
      const stale = await base();
      await save({ SESSION_TTL: 600 });
      const settled = await stored();

      await save({ MFA_ENFORCEMENT: 'admins' }, stale);

      expect(await stored()).toBe(settled);
    });

    it('accepts a save based on the current file', async () => {
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

    it('writes nothing when validation fails', async () => {
      const before = await stored();

      await save({ MFA_ENFORCEMENT: 'everyone' });

      expect(await stored()).toBe(before);
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
    // Attribution is emitted with the write and consumed by the sync engine, which composes the
    // commit message when it next backs up. What must be true at write time is that the actor
    // and the key NAMES are recorded, and that no value ever is.
    it('records the actor', async () => {
      await save();

      expect(written.map((event) => event.actor)).toContain(ACTOR.email);
    });

    it('records the key that changed', async () => {
      await save();

      expect(written.flatMap((event) => event.keys)).toContain('MFA_ENFORCEMENT');
    });

    it('never puts a secret value in what it records', async () => {
      await save({ SMTP_PASSWORD: 'hunter2' });

      expect(JSON.stringify(written)).not.toContain('hunter2');
    });

    it('emits nothing at all when the save changes nothing', async () => {
      await save();
      written = [];

      await save();

      expect(written).toEqual([]);
    });
  });

  describe('serialisation between concurrent saves', () => {
    it('applies one and rejects the other as stale rather than losing a change', async () => {
      // Both editors read the same file. The lock makes them run in turn; the stale check
      // then catches the second, which would otherwise silently overwrite the first.
      const shared = await base();

      const [first, second] = await Promise.all([
        save({ SESSION_TTL: 600 }, shared),
        save({ MFA_ENFORCEMENT: 'admins' }, shared),
      ]);

      const outcomes = [first.ok, second.ok].sort();
      expect(outcomes).toEqual([false, true]);
    });
  });
});
