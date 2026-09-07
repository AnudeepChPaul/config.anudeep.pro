import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Decryption of SOPS-encrypted values, in memory only.
 *
 * The `sops` binary is invoked rather than the format reimplemented. Reimplementing would mean
 * writing age (X25519, HKDF, ChaCha20-Poly1305) and the SOPS key-derivation by hand — a few
 * hundred lines of cryptography whose bugs are silent, to avoid one subprocess per namespace
 * per reload.
 *
 * The **ciphertext** is handed to sops as a short-lived file in a private 0700 directory, and
 * the plaintext comes back over stdout. Writing the ciphertext leaks nothing — those are the
 * same bytes already committed to git — while the plaintext never touches a disk that is backed
 * up, which is the one thing encrypting it at rest was for.
 *
 * Piping the document in over `/dev/stdin` was tried and does not work: Node's `spawn` gives a
 * child a **socketpair** for its stdio, and opening a socket through `/proc/self/fd/0` fails
 * with ENXIO. It happens to work from a shell, which is what makes it a trap.
 */

export class SopsError extends Error {}

/**
 * The command used to decrypt, as data so it can be asserted on.
 *
 * The age key goes in the environment. In argv it would be world-readable through
 * `/proc/<pid>/cmdline` for as long as the subprocess lived; another uid's environment is not
 * readable without root.
 *
 * The environment is built from nothing rather than inherited: this service's own env holds the
 * database URLs that deliberately never went into config, and a decryption helper has no reason
 * to receive them.
 */
export function buildDecryptCommand(
  ageKey: string,
  documentPath = '<document>',
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: ['--decrypt', '--input-type', 'yaml', '--output-type', 'yaml', documentPath],
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', SOPS_AGE_KEY: ageKey },
  };
}

/** Whether a document carries a SOPS metadata block, and therefore holds encrypted values. */
export function isEncrypted(source: string): boolean {
  try {
    const parsed = parseYaml(source) as Record<string, unknown> | null;
    return typeof parsed === 'object' && parsed !== null && 'sops' in parsed;
  } catch {
    // Malformed YAML is not this module's error to report — the loader parses next and will
    // name the file properly.
    return false;
  }
}

/**
 * Removes the age key from text that is about to become an error message.
 *
 * Defence in depth: sops does not echo the key today, so nothing currently depends on this.
 * It is here because error text reaches logs, spans and error trackers, and a decryption
 * failure is exactly the moment someone pastes a whole stack trace into a chat window — and a
 * future sops release that got chattier would otherwise leak the key silently.
 */
export function redactAgeKey(text: string, ageKey: string): string {
  return ageKey ? text.split(ageKey).join('[redacted age key]') : text;
}

export class SopsDecryptor {
  /** `tempRoot` exists so a test can watch the directory the ciphertext passes through. */
  constructor(
    private readonly ageKey: string,
    private readonly tempRoot: string = tmpdir(),
  ) {}

  /**
   * Returns the document with its secret values in plaintext and the `sops` block removed.
   *
   * A document with no sops block is returned untouched: most namespaces hold no secrets, and
   * requiring a block in every file would mean an age key is needed to read configuration that
   * is not secret.
   */
  async decrypt(path: string, source: string): Promise<string> {
    if (!isEncrypted(source)) return source;

    if (!this.ageKey) {
      throw new SopsError(`cannot decrypt ${path}: no age key is configured`);
    }

    const { stdout, stderr, code } = await this.withCiphertextFile(source, (file) => {
      const { args, env } = buildDecryptCommand(this.ageKey, file);
      return run('sops', args, env);
    });

    if (code !== 0) {
      // The message carries sops's own diagnosis — a wrong recipient, a failed MAC — with the
      // key scrubbed, because a decryption failure is exactly the moment someone pastes a whole
      // stack trace into a chat window.
      throw new SopsError(
        `could not decrypt ${path}: ${this.scrub(stderr.trim()) || `sops exited ${code}`}`,
      );
    }

    return stdout;
  }

  /**
   * Runs `fn` against a file holding the ciphertext, and removes it afterwards whether the
   * decryption succeeded or failed. The directory is 0700 and per-call, so no other uid on the
   * host can read the document and two concurrent reloads cannot collide.
   */
  private async withCiphertextFile<T>(
    source: string,
    fn: (file: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(this.tempRoot, 'config-sops-'));
    const file = join(dir, 'document.yaml');
    try {
      await writeFile(file, source, { encoding: 'utf8', mode: 0o600 });
      return await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private scrub(text: string): string {
    return redactAgeKey(text, this.ageKey);
  }
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}
