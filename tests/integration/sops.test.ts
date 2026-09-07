import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDecryptCommand, SopsDecryptor } from '@config/src/store/sops.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AgeKeypair, generateAgeKey, hasSops, sopsEncrypt } from '../helpers.js';

/**
 * Decryption of secret values, against the real `sops` binary and a real age key.
 *
 * Nothing here is mocked. A stubbed decryptor would prove that the stub returns what it was
 * told to; the properties that matter — that a wrong key fails, that tampering is detected, and
 * that plaintext never touches the disk — are properties of the tool and of how it is invoked.
 *
 * `sops` and `age` are absent on darwin, so this file runs in the container. See Dockerfile.test.
 */

const withSops = hasSops() ? describe : describe.skip;

const PLAINTEXT = `MFA_ENFORCEMENT: all
REGISTRATION_MODE: invite_only
SMTP_PASSWORD: hunter2
`;

/** Only the password is encrypted; toggles stay readable so a diff still says what changed. */
const SECRET_KEYS = '^(SMTP_PASSWORD)$';

withSops('SopsDecryptor', () => {
  let key: AgeKeypair;
  let encrypted: string;

  beforeAll(() => {
    key = generateAgeKey();
    encrypted = sopsEncrypt(PLAINTEXT, { recipient: key.recipient, encryptedRegex: SECRET_KEYS });
  });

  describe('the fixture itself', () => {
    it('hides the secret value but not the key names', () => {
      // The premise of storing config in git: a reviewer can see that SMTP_PASSWORD changed
      // without being able to read it. If sops encrypted whole files, `git log` would stop
      // being an audit trail.
      expect(encrypted).not.toContain('hunter2');
      expect(encrypted).toContain('SMTP_PASSWORD');
      expect(encrypted).toContain('ENC[AES256_GCM');
    });

    it('leaves non-secret values readable in the committed file', () => {
      expect(encrypted).toContain('invite_only');
    });
  });

  describe('decrypt', () => {
    it('recovers the original document', async () => {
      const decryptor = new SopsDecryptor(key.secret);

      expect(await decryptor.decrypt('config/iam/prod.yaml', encrypted)).toContain('hunter2');
    });

    it('leaves the non-secret values as they were', async () => {
      const decryptor = new SopsDecryptor(key.secret);

      const plaintext = await decryptor.decrypt('config/iam/prod.yaml', encrypted);

      expect(plaintext).toContain('MFA_ENFORCEMENT: all');
      expect(plaintext).toContain('REGISTRATION_MODE: invite_only');
    });

    it('strips the sops metadata block, leaving a plain config document', async () => {
      // What the loader parses must be the config and nothing else, or `sops` would appear as a
      // config key and the schema validator would reject every encrypted namespace.
      const decryptor = new SopsDecryptor(key.secret);

      expect(await decryptor.decrypt('config/iam/prod.yaml', encrypted)).not.toContain('sops:');
    });

    it('passes through a document that was never encrypted', async () => {
      // Most namespaces hold no secrets at all. Requiring a sops block in every file would mean
      // an age key is needed to read configuration that is not secret.
      const decryptor = new SopsDecryptor(key.secret);

      expect(await decryptor.decrypt('config/api/prod.yaml', PLAINTEXT)).toBe(PLAINTEXT);
    });
  });

  describe('failure', () => {
    it('fails with a different age key rather than returning something', async () => {
      const decryptor = new SopsDecryptor(generateAgeKey().secret);

      await expect(decryptor.decrypt('config/iam/prod.yaml', encrypted)).rejects.toThrow();
    });

    it('fails when no age key is configured at all', async () => {
      const decryptor = new SopsDecryptor('');

      await expect(decryptor.decrypt('config/iam/prod.yaml', encrypted)).rejects.toThrow(
        /age key/i,
      );
    });

    it('detects a tampered ciphertext instead of decrypting it to something else', async () => {
      // AES-GCM is authenticated, so this is really a test that the authentication tag is being
      // checked. Someone with write access to the repo but not the age key must not be able to
      // flip a secret to a value of their choosing.
      const decryptor = new SopsDecryptor(key.secret);
      const tampered = encrypted.replace(
        /data:([A-Za-z0-9+/=]{4})/,
        (_m, d) => `data:${d === 'AAAA' ? 'BBBB' : 'AAAA'}`,
      );

      await expect(decryptor.decrypt('config/iam/prod.yaml', tampered)).rejects.toThrow();
    });

    it('names the file it could not decrypt', async () => {
      const decryptor = new SopsDecryptor(generateAgeKey().secret);

      await expect(decryptor.decrypt('config/iam/prod.yaml', encrypted)).rejects.toThrow(
        /config\/iam\/prod\.yaml/,
      );
    });

    it('does not put the age key in the error it throws', async () => {
      // Errors reach logs, spans and error trackers. A decryption failure is exactly the moment
      // someone pastes the whole stack trace into a chat window.
      const wrong = generateAgeKey().secret;
      const decryptor = new SopsDecryptor(wrong);

      const error = await decryptor
        .decrypt('config/iam/prod.yaml', encrypted)
        .catch((e: Error) => e);

      expect(String((error as Error).stack ?? error)).not.toContain(wrong);
    });
  });

  describe('key handling', () => {
    it('leaves nothing behind after a successful decrypt', async () => {
      // sops is handed the ciphertext as a file, because Node's socketpair stdio makes
      // /dev/stdin unusable. The ciphertext is safe to write — those bytes are already in git —
      // but the file must not outlive the call.
      const scratch = await mkdtemp(join(tmpdir(), 'config-sops-watch-'));
      const decryptor = new SopsDecryptor(key.secret, scratch);

      await decryptor.decrypt('config/iam/prod.yaml', encrypted);

      expect(await readdir(scratch)).toEqual([]);
      await rm(scratch, { recursive: true, force: true });
    });

    it('leaves nothing behind when decryption fails', async () => {
      // The error path is the one that gets forgotten, and a wrong age key at boot would
      // otherwise litter a temp directory on every retry.
      const scratch = await mkdtemp(join(tmpdir(), 'config-sops-watch-'));
      const decryptor = new SopsDecryptor(generateAgeKey().secret, scratch);

      await decryptor.decrypt('config/iam/prod.yaml', encrypted).catch(() => {});

      expect(await readdir(scratch)).toEqual([]);
      await rm(scratch, { recursive: true, force: true });
    });

    it('never writes the decrypted plaintext to disk', async () => {
      // "Decrypt in memory only" is the actual requirement. What goes to disk is the ciphertext
      // that is already public within the repo; the secret comes back over stdout.
      const scratch = await mkdtemp(join(tmpdir(), 'config-sops-watch-'));
      const written: string[] = [];
      const decryptor = new SopsDecryptor(key.secret, scratch);

      // Record everything the call puts on disk, before it can be cleaned up.
      const watch = setInterval(() => {
        for (const entry of readdirSync(scratch)) {
          const file = join(scratch, entry, 'document.yaml');
          if (existsSync(file)) written.push(readFileSync(file, 'utf8'));
        }
      }, 1);

      await decryptor.decrypt('config/iam/prod.yaml', encrypted);
      clearInterval(watch);

      expect(written.length).toBeGreaterThan(0);
      for (const contents of written) expect(contents).not.toContain('hunter2');
      await rm(scratch, { recursive: true, force: true });
    });

    it('passes the age key in the environment, never in argv', () => {
      // argv is world-readable through /proc/<pid>/cmdline: any process on the host could read
      // the key for as long as the subprocess runs. The environment of another uid's process
      // is not readable without root.
      const { args, env } = buildDecryptCommand(key.secret);

      expect(args.join(' ')).not.toContain(key.secret);
      expect(env.SOPS_AGE_KEY).toBe(key.secret);
    });

    it('does not hand the subprocess the rest of this process environment', () => {
      // The service's own environment holds the database URLs that deliberately never went
      // into config. A decryption helper has no reason to receive them.
      process.env.CONFIG_TEST_CANARY = 'must-not-propagate';
      const { env } = buildDecryptCommand(key.secret);

      expect(env.CONFIG_TEST_CANARY).toBeUndefined();
    });
  });
});
