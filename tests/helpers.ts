import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { BreakGlass } from '@config/src/auth/break-glass.js';
import { SessionCodec } from '@config/src/auth/session.js';
import { GitRepository } from '@config/src/git/repository.js';
import { SESSION_COOKIE } from '@config/src/routes/auth.js';
import { DBEngine, type WriteEvent } from '@config/src/store/data-layer.js';
import type { ConfigLoader } from '@config/src/store/loader.js';
import { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { ConfigWriteService } from '@config/src/store/write-service.js';

/** Migrate a legacy repository fixture into an isolated authoritative DB, never production data. */
export async function liveOptions(
  repoDir: string,
  schemas: Record<string, string>,
  loader: ConfigLoader,
  onWrite?: (event: WriteEvent) => void,
) {
  const repository = new GitRepository(repoDir);
  const db = new DBEngine(join(repoDir, '.test-db'), onWrite ? { onWrite } : {});
  const sources = await repository.readSources();
  const files = [
    ...Object.entries(schemas).map(([name, source]) => ({
      path: `schema/${name}.yaml`,
      content: source,
    })),
    { path: 'services.yaml', content: await repository.readFile('services.yaml') },
    { path: 'environments.yaml', content: await repository.readFile('environments.yaml') },
    ...[...sources.sources].map(([namespace, content]) => ({
      path: `config/${namespace}.yaml`,
      content,
    })),
  ];
  await db.writeMany(files);
  return {
    db,
    loader,
    operations: new ConfigWriteService({ db, loader, encryptor: new SopsEncryptor(repoDir) }),
  };
}

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

  /** A clone of another repository, with it as origin — for exercising pull. */
  static async cloneOf(source: string): Promise<TestRepo> {
    const dir = await mkdtemp(join(tmpdir(), 'config-clone-'));
    await run('git', ['clone', source, dir]);
    const repo = new TestRepo(dir);
    await repo.git('config', 'user.email', 'test@anudeep.pro');
    await repo.git('config', 'user.name', 'config test');
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

/**
 * A guarded console, and the cookie that gets past its guard.
 *
 * The console refuses to be built without authentication — in every environment, since keying
 * that off an environment string is what let one unset variable serve it with no login on it.
 * So a test that wants to exercise a page has to build it guarded and sign in, which is what
 * this returns: the `auth` options to build with, and the cookie header to send.
 */
export function guarded(): {
  auth: {
    codec: SessionCodec;
    breakGlass: BreakGlass;
    isIamReachable: () => Promise<boolean>;
  };
  headers: { cookie: string };
} {
  const codec = new SessionCodec('y'.repeat(64));
  const session = codec.sign({
    email: 'me@anudeep.pro',
    id: '7f3a1c9e',
    via: 'iam',
    expiresAt: Date.now() + 3_600_000,
  });

  return {
    auth: {
      codec,
      breakGlass: new BreakGlass({
        record: null,
        isIamReachable: async () => true,
        alert: () => {},
      }),
      isIamReachable: async () => true,
    },
    headers: { cookie: `${SESSION_COOKIE}=${session}` },
  };
}

/**
 * A rendered page without its stylesheet.
 *
 * AC8 and AC9 are rules about what a reader sees: no screen refers to drafts or publishing, and
 * nothing implies a saved change is not yet in effect. The stylesheet is excluded because its
 * comments record WHY several rules exist, and two of those reasons were publish-era defects --
 * a Search button that submitted a publish, and a publish action painted in the state colour.
 * Deleting that history to satisfy a substring match would cost the explanation and protect
 * nothing.
 */
export const visible = (body: string): string => body.replace(/<style>[\s\S]*?<\/style>/, '');
