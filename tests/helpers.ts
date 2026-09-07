import { execFile } from 'node:child_process';
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

  /** Write and commit, returning the new sha. */
  async commit(files: Record<string, string>, message = 'change'): Promise<string> {
    for (const [path, contents] of Object.entries(files)) await this.write(path, contents);
    await this.git('add', '-A');
    await this.git('commit', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }
}
