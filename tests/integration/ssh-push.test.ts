import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSshCommand, GitRepository } from '@config/src/git/repository.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The push path against a real remote over SSH.
 *
 * Every other push test uses a local bare repository, which never touches SSH — so the deploy
 * key, the ssh options and the transport itself are untested by them. This closes that, but it
 * needs credentials and the network, so it is opt-in and skipped everywhere else:
 *
 *   CONFIG_SSH_PUSH_REMOTE=git@github.com:you/config.bare.anudeep.pro.git \
 *   CONFIG_SSH_PUSH_KEY=~/.ssh/your-key \
 *   pnpm vitest run tests/integration/ssh-push.test.ts
 *
 * It pushes a real commit to that remote. Point it at a repository where that is acceptable.
 */

const REMOTE = process.env.CONFIG_SSH_PUSH_REMOTE;
const KEY = process.env.CONFIG_SSH_PUSH_KEY;
const KNOWN_HOSTS =
  process.env.CONFIG_SSH_PUSH_KNOWN_HOSTS ?? `${process.env.HOME}/.ssh/known_hosts`;

const configured = Boolean(REMOTE && KEY);
const withRemote = configured ? describe : describe.skip;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

withRemote('pushing to a real remote over SSH', () => {
  const ssh = { keyPath: KEY ?? '', knownHostsPath: KNOWN_HOSTS };

  const clone = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'config-sshpush-'));
    dirs.push(dir);
    execFileSync('git', ['clone', '--quiet', REMOTE ?? '', dir], {
      env: { ...process.env, GIT_SSH_COMMAND: buildSshCommand(ssh) },
    });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'config@anudeep.pro']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'config service']);
    return dir;
  };

  const remoteHead = () =>
    execFileSync('git', ['ls-remote', REMOTE ?? '', 'refs/heads/main'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_SSH_COMMAND: buildSshCommand(ssh) },
    })
      .trim()
      .split(/\s+/)[0];

  it('publishes a commit the remote did not have', async () => {
    const dir = await clone();
    const git = new GitRepository(dir, ssh);
    const before = await git.headCommit();

    // A value that differs from what is committed. Writing identical bytes takes
    // writeAndCommit's no-op path, and then "the remote matches" is true because nothing
    // happened — which is exactly how this check passes while proving nothing. It did, once.
    const timeout = 5000 + (Date.now() % 1000);
    const sha = await git.writeAndCommit(
      { 'config/api/prod.yaml': `RATE_LIMIT: 100\nREQUEST_TIMEOUT_MS: ${timeout}\n` },
      `Exercise the SSH push path\n\nActor: config@anudeep.pro\nService: api\nEnvironment: prod\n`,
    );

    expect(sha).not.toBe(before);
    expect(await git.unpushedCommits()).toHaveLength(1);

    const result = await git.push();

    expect(result.pushed).toBe(true);
    expect(await git.unpushedCommits()).toHaveLength(0);
    expect(remoteHead()).toBe(sha);
  });

  it('builds an ssh command the transport actually accepts', async () => {
    // The options are asserted as a string elsewhere; this proves the real ssh binary and a
    // real server accept them together — IdentitiesOnly with a key that is not the default,
    // and host checking left on.
    const dir = await clone();

    expect(await new GitRepository(dir, ssh).unpushedCommits()).toEqual([]);
    expect(buildSshCommand(ssh)).toContain('StrictHostKeyChecking=yes');
  });
});
