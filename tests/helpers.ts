import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A throwaway git repository on disk.
 *
 * The git tests drive the real binary against a real repo rather than a mocked porcelain,
 * because every property worth asserting here is a property of git: that a read sees committed
 * state and not a dirty working tree, and that the sha a read reports is the one it read at.
 */
export class TestRepo {
  private constructor(readonly dir: string) {}

  static async create(): Promise<TestRepo> {
    const dir = await mkdtemp(join(tmpdir(), 'config-repo-'));
    const repo = new TestRepo(dir);
    await repo.git('init', '--initial-branch=main');
    await repo.git('config', 'user.email', 'test@anudeep.pro');
    await repo.git('config', 'user.name', 'config test');
    await repo.git('commit', '--allow-empty', '-m', 'root');
    return repo;
  }

  async git(...args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.dir });
    return stdout.trim();
  }

  /** Write a file in the working tree without committing it. */
  async write(path: string, contents: string): Promise<void> {
    const full = join(this.dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }

  /**
   * Gives this repo a bare remote and returns its path.
   *
   * A local bare repository rather than a real GitHub: push, fetch and the remote-tracking refs
   * behave identically, and the parts that differ — SSH transport and the deploy key — are
   * asserted separately on the command that is built, not by talking to GitHub from a test.
   */
  async addRemote(name = 'origin'): Promise<string> {
    const remote = await mkdtemp(join(tmpdir(), 'config-remote-'));
    await run('git', ['init', '--bare', '--initial-branch=main'], { cwd: remote });
    await this.git('remote', 'add', name, remote);
    await this.git('push', '-u', name, 'main');
    return remote;
  }

  /** Points the remote at a path that does not exist, so pushes fail as they would offline. */
  async breakRemote(name = 'origin'): Promise<void> {
    await this.git('remote', 'set-url', name, join(this.dir, 'no-such-remote.git'));
  }

  /** Write and commit, returning the new sha. */
  async commit(files: Record<string, string>, message = 'change'): Promise<string> {
    for (const [path, contents] of Object.entries(files)) await this.write(path, contents);
    await this.git('add', '-A');
    await this.git('commit', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }
}

/** Whether the SOPS toolchain is present. Absent on darwin; installed in Dockerfile.test. */
export const hasSops = (): boolean => {
  try {
    execFileSync('sops', ['--version'], { stdio: 'ignore' });
    execFileSync('age-keygen', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export interface AgeKeypair {
  /** `AGE-SECRET-KEY-1...` — what the service holds in env. */
  readonly secret: string;
  /** `age1...` — what `.sops.yaml` lists as a recipient. */
  readonly recipient: string;
}

/** A real age keypair. Generated per test rather than checked in, so nothing is a shared secret. */
export function generateAgeKey(): AgeKeypair {
  const output = execFileSync('age-keygen', { encoding: 'utf8' });
  const secret = output.split('\n').find((line) => line.startsWith('AGE-SECRET-KEY-'));
  const recipient = output.match(/public key: (age1\S+)/)?.[1];
  if (!secret || !recipient) throw new Error(`could not parse age-keygen output: ${output}`);
  return { secret, recipient };
}

/**
 * Encrypts with the real `sops` binary.
 *
 * The fixtures are produced by the tool that produces them in production. Hand-written
 * ciphertext would only prove the decryptor can read hand-written ciphertext.
 */
export function sopsEncrypt(
  source: string,
  options: { recipient: string; encryptedRegex?: string },
): string {
  // A file rather than `/dev/stdin`: Node hands a spawned child a socketpair for its stdio, and
  // opening that through /proc/self/fd/0 fails with ENXIO. See src/store/sops.ts.
  const dir = mkdtempSync(join(tmpdir(), 'config-sops-fixture-'));
  const file = join(dir, 'document.yaml');
  try {
    writeFileSync(file, source, 'utf8');
    const args = [
      '--encrypt',
      '--input-type',
      'yaml',
      '--output-type',
      'yaml',
      '--age',
      options.recipient,
    ];
    if (options.encryptedRegex) args.push('--encrypted-regex', options.encryptedRegex);
    args.push(file);
    return execFileSync('sops', args, { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
