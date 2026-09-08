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

export interface PushResult {
  readonly pushed: boolean;
  /** Why not, when `pushed` is false. Carried to the UI's unpublished banner. */
  readonly reason?: string;
}

export interface LastChange {
  readonly sha: Sha;
  readonly subject: string;
  readonly author: string;
  /** ISO 8601, so the page can say "2h ago" without the server guessing a timezone. */
  readonly at: string;
}

export interface UnpushedCommit {
  readonly sha: Sha;
  readonly subject: string;
}

export interface SshOptions {
  /** The deploy key. Read-write, scoped to one repository, revocable in a click. */
  readonly keyPath: string;
  readonly knownHostsPath?: string;
}

/**
 * The ssh invocation git uses for remote operations.
 *
 * `IdentitiesOnly=yes` because otherwise ssh offers every key it can find, including the box's
 * own, and may authenticate as somebody else entirely — which tends to work in development and
 * fail confusingly in production.
 *
 * Host key checking stays on. Disabling it is the usual shortcut and it removes the only thing
 * standing between a push and handing the repository's entire history to an impostor of
 * github.com.
 */
export function buildSshCommand(options: SshOptions): string {
  const parts = [
    'ssh',
    `-i ${options.keyPath}`,
    '-o IdentitiesOnly=yes',
    '-o StrictHostKeyChecking=yes',
  ];
  if (options.knownHostsPath) parts.push(`-o UserKnownHostsFile=${options.knownHostsPath}`);
  return parts.join(' ');
}

/** Hosts whose commit URL layout is known. Guessing one for anything else produces a link that
 *  404s at best, and at worst sends an operator mid-incident to somebody else's repository. */
const WEB_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/**
 * The browser address for a push remote, or null when there is not one to be sure of.
 *
 * git pushes over SSH and a reader clicks HTTPS, so the two forms have to be converted between.
 * Credentials embedded in an https remote are dropped rather than rendered into a page.
 */
export function webUrlFor(remote: string | null | undefined): string | null {
  if (!remote) return null;

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote);
  const url = /^(?:ssh|git|https?):\/\//.test(remote)
    ? (() => {
        try {
          const parsed = new URL(remote);
          return { host: parsed.hostname, path: parsed.pathname.replace(/^\//, '') };
        } catch {
          return null;
        }
      })()
    : scp && !remote.startsWith('/')
      ? { host: scp[1] ?? '', path: scp[2] ?? '' }
      : null;

  if (!url || !WEB_HOSTS.has(url.host)) return null;
  const path = url.path.replace(/\.git$/, '');
  return path ? `https://${url.host}/${path}` : null;
}

export class GitRepositoryError extends Error {}

export class GitRepository {
  constructor(
    private readonly dir: string,
    private readonly ssh?: SshOptions,
  ) {}

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await run('git', args, {
        cwd: this.dir,
        maxBuffer: 32 * 1024 * 1024,
        env: this.ssh
          ? { ...process.env, GIT_SSH_COMMAND: buildSshCommand(this.ssh) }
          : process.env,
      });
      return stdout;
    } catch (cause) {
      throw new GitRepositoryError(`git ${args[0]} failed in ${this.dir}`, { cause });
    }
  }

  /** The configured push remote, or null when the clone is deliberately local. */
  private async remoteName(): Promise<string | null> {
    try {
      const remotes = (await this.git('remote')).trim();
      return remotes ? (remotes.split('\n')[0] ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * The most recent commit touching one path: the audit trail's latest entry for a namespace.
   *
   * Null when no commit has ever touched it — a namespace can exist as a draft before it exists
   * as a file, and that is not an error.
   */
  async lastChange(path: string): Promise<LastChange | null> {
    try {
      const out = (
        await this.git('log', '-1', '--format=%H%x00%s%x00%an%x00%aI', '--', path)
      ).trim();
      if (!out) return null;

      const [sha, subject, author, at] = out.split('\0');
      if (!sha || !at) return null;
      return { sha: sha as Sha, subject: subject ?? '', author: author ?? '', at };
    } catch {
      return null;
    }
  }

  /**
   * Points `origin` at `url`, adding it or moving it. Never throws.
   *
   * The repository is created locally — by the seed script, or by a first boot on a fresh host
   * — and nothing in git carries the remote across that. Without this step push answers "no
   * remote is configured" for the life of the deployment and every publish reports itself as
   * not pushed, which is durable but is not backed up anywhere.
   *
   * A null url is a deliberately local registry and must stay one.
   */
  async ensureRemote(url: string | null): Promise<void> {
    if (!url) return;

    try {
      const current = (await this.git('remote', 'get-url', 'origin').catch(() => '')).trim();
      if (current === url) return;
      // set-url on a remote that does not exist fails, and add on one that does; which applies
      // depends on how this host was brought up, so both are tried.
      if (current) await this.git('remote', 'set-url', 'origin', url);
      else await this.git('remote', 'add', 'origin', url);
    } catch {
      // Boot must not depend on this. A push will report the real reason soon enough, on a
      // page an operator is actually looking at.
    }
  }

  /**
   * Publishes local commits. Never throws.
   *
   * A GitHub outage must not become a 500 on a save that already succeeded locally, so the
   * failure is returned and the caller decides what to show.
   */
  async push(): Promise<PushResult> {
    const remote = await this.remoteName();
    if (!remote) {
      // Saying "pushed" here would be a lie the UI would render as published, on a repository
      // that has no off-host copy at all.
      return { pushed: false, reason: 'no remote is configured' };
    }

    try {
      await this.git('push', remote, 'HEAD:main');
      return { pushed: true };
    } catch (cause) {
      return this.rebaseAndPush(remote, cause as Error);
    }
  }

  /**
   * The second attempt, after a rejected push.
   *
   * Two hosts editing one registry both commit locally, and whoever pushes second is rejected
   * as non-fast-forward. Rebasing keeps both sets of commits. Forcing would keep only ours,
   * which on a configuration registry means deleting a change somebody else has already
   * published and is being served.
   *
   * Anything that fails here — the remote is down rather than ahead, or the rebase conflicts —
   * leaves the local commit exactly where it was and reports why.
   */
  private async rebaseAndPush(remote: string, first: Error): Promise<PushResult> {
    try {
      await this.git('fetch', remote, 'main');
    } catch {
      // Not a divergence: the remote is unreachable. Report the original push failure, which
      // says so more precisely than a fetch error would.
      return { pushed: false, reason: first.message };
    }

    try {
      await this.git('rebase', 'FETCH_HEAD');
    } catch (cause) {
      // A half-finished rebase leaves a detached HEAD and a dirty tree, and the next read is
      // served from HEAD. Abandoning it puts the branch back exactly as it was.
      await this.git('rebase', '--abort').catch(() => {});
      return { pushed: false, reason: `remote has diverged: ${(cause as Error).message}` };
    }

    try {
      await this.git('push', remote, 'HEAD:main');
      return { pushed: true };
    } catch (cause) {
      return { pushed: false, reason: (cause as Error).message };
    }
  }

  /**
   * Commits the remote does not have, newest first.
   *
   * Empty when no remote is configured: there is nothing to be behind, and reporting all of
   * history as unpushed would leave a permanent warning on a deliberately local repository.
   */
  async unpushedCommits(): Promise<UnpushedCommit[]> {
    const remote = await this.remoteName();
    if (!remote) return [];

    let output: string;
    try {
      output = await this.git('log', `${remote}/main..HEAD`, '--format=%H%x00%s');
    } catch {
      // No remote-tracking ref yet — nothing has ever been fetched or pushed.
      return [];
    }

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', subject = ''] = line.split('\0');
        return { sha, subject };
      });
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

    const paths = Object.keys(files);
    await this.git('add', '--', ...paths);

    // Saving a value identical to the current one is not an error, but it is not history
    // either: an empty commit is something a reviewer has to read and rule out. Scoped to the
    // paths this call wrote, so a leftover from an earlier failure does not make an unrelated
    // commit look non-empty.
    const staged = await this.git('diff', '--cached', '--name-only', '--', ...paths);
    if (!staged.trim()) return this.headCommit();

    try {
      await this.commitStaged(message, paths);
    } catch (cause) {
      // Leaving them staged is how a refused commit contaminated the next one: the following
      // publish committed its own file and swept these along, under its message, its trailers
      // and its actor. The audit trail is the record here, so a commit that says the wrong
      // thing about who changed what is worse than no commit at all.
      await this.discard(paths);
      throw cause;
    }
    return this.headCommit();
  }

  /**
   * Puts the named paths back to HEAD, in the index and in the working tree.
   *
   * Scoped to the paths, never the whole tree: this clone belongs to the service, but a
   * `reset --hard` would still destroy anything else in flight, and there is no reason to
   * touch what this call did not write.
   */
  private async discard(paths: readonly string[]): Promise<void> {
    try {
      await this.git('reset', '--quiet', 'HEAD', '--', ...paths);
      // A path HEAD does not have cannot be checked out; removing it is what "back to HEAD"
      // means for a file this call created.
      for (const path of paths) {
        const known = await this.git('ls-tree', '--name-only', 'HEAD', '--', path).catch(() => '');
        if (known.trim()) await this.git('checkout', '--', path);
        else await rm(join(this.dir, path), { force: true });
      }
    } catch {
      // The commit failure is the interesting one and is about to be rethrown; a rollback that
      // also fails must not replace it with a message about cleaning up.
    }
  }

  private async commitStaged(message: string, paths: readonly string[]): Promise<void> {
    // `--file -` would need stdin, which Node's socketpair stdio makes unreliable; a temp file
    // in the repo's own .git directory avoids both that and the shell quoting that `-m` invites.
    const messageFile = join(this.dir, '.git', `COMMIT_EDITMSG_${process.pid}`);
    await writeFile(messageFile, message, 'utf8');
    try {
      // The pathspec is the second half of the isolation: whatever else happens to be staged
      // in this clone cannot ride along on this commit.
      await this.git('commit', '--file', messageFile, '--cleanup=verbatim', '--', ...paths);
    } finally {
      await rm(messageFile, { force: true });
    }
  }

  /**
   * Fast-forwards to the remote, returning the commit now at HEAD.
   *
   * Fast-forward only. If local and remote have diverged, a merge here would produce
   * configuration nobody wrote — and the local side is the durable, already-serving one. That
   * is a human's decision, so this fails instead.
   */
  async pull(): Promise<Sha> {
    const remote = await this.remoteName();
    if (!remote) return this.headCommit();

    await this.git('fetch', remote, 'main');
    await this.git('merge', '--ff-only', `${remote}/main`);
    return this.headCommit();
  }

  /** One file's contents as committed at HEAD. */
  async readFile(path: string): Promise<string> {
    return this.git('show', `${await this.headCommit()}:${path}`);
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
