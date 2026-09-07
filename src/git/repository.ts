import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Namespace } from '../identity/types.js';
import { isNamespace } from '../namespace.js';
import type { ConfigSources, Sha } from '../store/types.js';

/**
 * The read half of the git engine.
 *
 * Reads go through `git show`/`git ls-tree` against **HEAD**, not against the checked-out files.
 * The working tree is dirty during a pull, mid-write, and after a crash; serving from it would
 * hand services values that no commit records and no audit trail explains. Reading the object
 * store means a read is always of a state that someone committed.
 *
 * The git binary is shelled out to rather than reimplemented: the deploy-key SSH transport,
 * packfiles and ref locking are all things git already does correctly.
 */

const run = promisify(execFile);

/** Where namespace files live. Everything else in the repo is not configuration. */
const CONFIG_DIR = 'config';
/** Where the typed key definitions live, one file per service. */
const SCHEMA_DIR = 'schema';

export class GitRepositoryError extends Error {}

export class GitRepository {
  constructor(private readonly dir: string) {}

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await run('git', args, { cwd: this.dir, maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (cause) {
      throw new GitRepositoryError(`git ${args[0]} failed in ${this.dir}`, { cause });
    }
  }

  async headCommit(): Promise<Sha> {
    return (await this.git('rev-parse', 'HEAD')).trim();
  }

  /**
   * Every namespace's file text as of HEAD, with the sha it was read at.
   *
   * Text, not parsed values: a SOPS document is not the document it will become, so parsing
   * here would type-check ciphertext. Decryption and parsing belong to the loader.
   *
   * The sha is read first and every file is then read *at that sha*, so a commit landing
   * mid-read cannot produce a tree that mixes two states — and the reported sha is genuinely
   * the one the values came from, which is what slice 7's stale check depends on.
   */
  async readSources(): Promise<ConfigSources> {
    const commit = await this.headCommit();
    const sources = new Map<Namespace, string>();

    for (const path of await this.listYamlFiles(commit, CONFIG_DIR)) {
      sources.set(this.namespaceOf(path), await this.git('show', `${commit}:${path}`));
    }

    return { commit, sources };
  }

  /**
   * Every service's schema source as of HEAD, keyed by service name.
   *
   * Returned as raw text rather than parsed, so that parsing and its error messages stay in
   * the validator, which is where the reader of an error will look for them.
   */
  async readSchemas(): Promise<Record<string, string>> {
    const commit = await this.headCommit();
    const schemas: Record<string, string> = {};

    for (const path of await this.listYamlFiles(commit, SCHEMA_DIR)) {
      const service = path.slice(SCHEMA_DIR.length + 1, -'.yaml'.length);
      if (service.includes('/')) {
        throw new GitRepositoryError(
          `${path} is not a schema file: expected ${SCHEMA_DIR}/<service>.yaml`,
        );
      }
      schemas[service] = await this.git('show', `${commit}:${path}`);
    }

    return schemas;
  }

  /**
   * Writes the given files and commits them as a single change.
   *
   * `files` maps repository-relative paths to their new contents, or to null to delete. One
   * save is one commit: splitting it would allow a partial rollback and would publish an
   * intermediate state that no operator ever chose.
   *
   * The message is passed through a file rather than `-m` so that trailers, blank lines and
   * anything else in it survive exactly as built — the message is the audit record.
   */
  async writeAndCommit(files: Record<string, string | null>, message: string): Promise<Sha> {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(this.dir, path);
      if (contents === null) {
        await rm(full, { force: true });
      } else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, contents, 'utf8');
      }
    }

    await this.git('add', '--', ...Object.keys(files));

    // Saving a value identical to the current one is not an error, but it is not history
    // either: an empty commit is something a reviewer has to read and rule out.
    const staged = await this.git('diff', '--cached', '--name-only');
    if (!staged.trim()) return this.headCommit();

    await this.commitStaged(message);
    return this.headCommit();
  }

  private async commitStaged(message: string): Promise<void> {
    // `--file -` would need stdin, which Node's socketpair stdio makes unreliable; a temp file
    // in the repo's own .git directory avoids both that and the shell quoting that `-m` invites.
    const messageFile = join(this.dir, '.git', `COMMIT_EDITMSG_${process.pid}`);
    await writeFile(messageFile, message, 'utf8');
    try {
      await this.git('commit', '--file', messageFile, '--cleanup=verbatim');
    } finally {
      await rm(messageFile, { force: true });
    }
  }

  private async listYamlFiles(commit: Sha, dir: string): Promise<string[]> {
    // `-z` because a path may contain anything a filesystem allows; without it git quotes and
    // escapes unusual names and the split would be wrong.
    const output = await this.git('ls-tree', '-r', '--name-only', '-z', commit, '--', dir);
    return output.split('\0').filter((path) => path.endsWith('.yaml'));
  }

  private namespaceOf(path: string): Namespace {
    const candidate = path.slice(CONFIG_DIR.length + 1, -'.yaml'.length);
    if (!isNamespace(candidate)) {
      // Skipping it silently would mean an operator edits a file, sees a green commit, and the
      // value never reaches anything.
      throw new GitRepositoryError(
        `${path} is not a config file: expected ${CONFIG_DIR}/<service>/<environment>.yaml`,
      );
    }
    return candidate;
  }
}
