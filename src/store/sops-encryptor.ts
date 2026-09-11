import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logCaught, logged } from '@config/src/logging.js';
import type { Namespace } from '../identity/types.js';

/**
 * Encrypts a namespace document before it is committed.
 *
 * The rules come from the repository's own `.sops.yaml` — which keys are encrypted and to which
 * age recipients — so adding a recipient or changing what counts as a secret is a reviewable
 * commit rather than a redeploy. `--config` plus `--filename-override` lets sops apply those
 * rules to a document that is not in the repository, which is what keeps plaintext out of the
 * working tree.
 *
 * Encryption needs only the public recipients, so this class never sees the age private key.
 */

export class SopsEncryptError extends Error {}

export class SopsEncryptor {
  constructor(
    private readonly repoDir: string,
    private readonly tempRoot: string = tmpdir(),
  ) {}

  /**
   * Returns the document encrypted according to `.sops.yaml`.
   *
   * A repository with no `.sops.yaml` holds no secrets, and the document is returned unchanged
   * rather than failing: requiring the file would mean a config repo could not exist until
   * someone had generated an age key.
   */
  async encrypt(namespace: Namespace, plaintext: string): Promise<string> {
    return logged(undefined, 'config.sops.encrypt', { logger: 'store.sops', namespace }, async () => {
    const configPath = join(this.repoDir, '.sops.yaml');
    try {
      await access(configPath);
    } catch (error) {
      logCaught(error, 'config.sops.config.missing', { logger: 'store.sops' });
      return plaintext;
    }

    // The plaintext goes to a private 0700 directory, never into the repository. A crash
    // between writing and encrypting would otherwise leave a secret in the working tree, on the
    // volume that holds the clone.
    const dir = await mkdtemp(join(this.tempRoot, 'config-encrypt-'));
    const file = join(dir, 'document.yaml');
    try {
      await writeFile(file, plaintext, { encoding: 'utf8', mode: 0o600 });

      const { stdout, stderr, code } = await run('sops', [
        '--encrypt',
        '--config',
        configPath,
        // Makes the path_regex in .sops.yaml match the file's real home in the repository,
        // rather than the temp path it is being read from.
        '--filename-override',
        `config/${namespace}.yaml`,
        '--input-type',
        'yaml',
        '--output-type',
        'yaml',
        file,
      ]);

      if (code !== 0) {
        throw new SopsEncryptError(
          `could not encrypt config/${namespace}.yaml: ${stderr.trim() || `sops exited ${code}`}`,
        );
      }

      return stdout;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    });
  }
}

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
