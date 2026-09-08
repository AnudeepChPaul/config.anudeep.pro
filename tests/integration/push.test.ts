import { rm } from 'node:fs/promises';
import { buildSshCommand, GitRepository } from '@config/src/git/repository.js';
import { GitSyncer } from '@config/src/git/syncer.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TestRepo } from '../helpers.js';

/**
 * Publishing to GitHub, and surviving not being able to.
 *
 * The plan's chosen failure behaviour: a save is committed locally before the response, so
 * "saved" means durable even when the push fails. The commit is already being served; the push
 * is how it becomes off-host backup, and its failure must degrade rather than fail the save.
 *
 * The remote here is a local bare repository. Push, fetch and remote-tracking refs behave
 * identically; the SSH transport and the deploy key are asserted on the command that gets built.
 */

const repos: string[] = [];
const newRepo = async () => {
  const repo = await TestRepo.create();
  repos.push(repo.dir);
  return repo;
};

afterEach(async () => {
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GitRepository.ensureRemote', () => {
  // Without this the seeded repository has no remote at all, push returns "no remote is
  // configured", and every publish reports "not yet pushed to GitHub" forever — which is
  // exactly how the running console behaved.
  it('adds the remote when the repository has none', async () => {
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);

    await git.ensureRemote('git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git');

    expect(await repo.git('remote', 'get-url', 'origin')).toContain('config.bare.anudeep.pro');
  });

  it('moves an existing remote that points somewhere else', async () => {
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    const git = new GitRepository(repo.dir);

    await git.ensureRemote('git@github.com:AnudeepChPaul/other.git');

    expect(await repo.git('remote', 'get-url', 'origin')).toContain('other.git');
  });

  it('does nothing at all when no remote is configured, leaving a local repo local', async () => {
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);

    await git.ensureRemote(null);

    expect((await repo.git('remote')).trim()).toBe('');
  });

  it('never throws: a bad remote must not stop the service booting', async () => {
    const git = new GitRepository('/nowhere/at/all');

    await expect(git.ensureRemote('git@github.com:x/y.git')).resolves.toBeUndefined();
  });
});

describe('GitRepository.push', () => {
  it('rebases onto the remote and pushes again when the remote has moved ahead', async () => {
    // Two hosts editing the same registry: whoever pushes second is rejected as non-fast-
    // forward. Rebasing keeps both sets of commits; a force push would delete the other one's.
    const repo = await newRepo();
    const remote = await repo.addRemote();
    repos.push(remote);

    // Someone else's commit, made through a second clone of the same remote.
    const other = await newRepo();
    await other.git('remote', 'add', 'origin', remote);
    await other.git('fetch', 'origin');
    await other.git('reset', '--hard', 'origin/main');
    const theirs = (await other.commit({ 'config/iam/prod.yaml': 'THEIRS: 1\n' }, 'theirs')).trim();
    await other.git('push', 'origin', 'HEAD:main');

    const git = new GitRepository(repo.dir);
    const mine = await git.writeAndCommit({ 'config/iam/dev.yaml': 'MINE: 1\n' }, 'mine');

    const result = await git.push();

    expect(result.pushed).toBe(true);
    const head = await repo.git('ls-remote', remote, 'refs/heads/main');
    // Both commits survive, and mine is on top — its sha changed, so it is found by subject.
    expect(head).not.toContain(mine);
    expect(await repo.git('log', '--format=%s', '-3')).toContain('theirs');
    expect(await repo.git('log', '--format=%s', '-3')).toContain('mine');
    expect(await repo.git('rev-list', '--count', `${theirs}..HEAD`)).toContain('1');
  });

  it('reports the rejection rather than forcing when the rebase cannot be done', async () => {
    // A conflicting edit to the same key. Forcing here would discard the other host's commit.
    const repo = await newRepo();
    const remote = await repo.addRemote();
    repos.push(remote);

    const other = await newRepo();
    await other.git('remote', 'add', 'origin', remote);
    await other.git('fetch', 'origin');
    await other.git('reset', '--hard', 'origin/main');
    await other.commit({ 'config/iam/dev.yaml': 'A: theirs\n' }, 'theirs');
    await other.git('push', 'origin', 'HEAD:main');

    const git = new GitRepository(repo.dir);
    const mine = await git.writeAndCommit({ 'config/iam/dev.yaml': 'A: mine\n' }, 'mine');

    const result = await git.push();

    expect(result.pushed).toBe(false);
    expect(result.reason).toBeTruthy();
    // Still durable locally, and the tree is not left mid-rebase.
    expect(await repo.git('rev-parse', 'HEAD')).toContain(mine);
    expect(await repo.git('status', '--porcelain')).toBe('');
  });

  it('publishes local commits to the remote', async () => {
    const repo = await newRepo();
    const remote = await repo.addRemote();
    repos.push(remote);
    const git = new GitRepository(repo.dir);
    const sha = await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');

    const result = await git.push();

    expect(result.pushed).toBe(true);
    const remoteHead = await repo.git('ls-remote', remote, 'refs/heads/main');
    expect(remoteHead).toContain(sha);
  });

  it('reports failure rather than throwing when the remote is unreachable', async () => {
    // A GitHub outage must not turn into a 500 on a save that already succeeded locally.
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    await repo.breakRemote();
    const git = new GitRepository(repo.dir);
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');

    const result = await git.push();

    expect(result.pushed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('keeps the commit locally when the push fails', async () => {
    // The whole point of committing before pushing. The change is durable and already being
    // served, whatever GitHub is doing.
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    await repo.breakRemote();
    const git = new GitRepository(repo.dir);
    const sha = await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');

    await git.push();

    expect(await git.headCommit()).toBe(sha);
    expect((await git.readSources()).sources.get('iam/prod')).toBe('A: 1\n');
  });

  it('reports success when there is nothing to push', async () => {
    const repo = await newRepo();
    repos.push(await repo.addRemote());

    expect((await new GitRepository(repo.dir).push()).pushed).toBe(true);
  });

  it('reports failure when no remote is configured', async () => {
    // A repo with no remote has no off-host backup, and saying "pushed" would be a lie the UI
    // would then display as published.
    const repo = await newRepo();

    expect((await new GitRepository(repo.dir).push()).pushed).toBe(false);
  });
});

describe('GitRepository.unpushedCommits', () => {
  it('is empty when everything is published', async () => {
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    const git = new GitRepository(repo.dir);
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');
    await git.push();

    expect(await git.unpushedCommits()).toEqual([]);
  });

  it('lists the commits the remote does not have', async () => {
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    await repo.breakRemote();
    const git = new GitRepository(repo.dir);
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'first change');
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 2\n' }, 'second change');

    const unpushed = await git.unpushedCommits();

    expect(unpushed).toHaveLength(2);
    expect(unpushed.map((c) => c.subject)).toEqual(['second change', 'first change']);
  });

  it('carries the sha so the UI can show exactly what is unpublished', async () => {
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    await repo.breakRemote();
    const git = new GitRepository(repo.dir);
    const sha = await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');

    expect((await git.unpushedCommits())[0]?.sha).toBe(sha);
  });

  it('is empty when no remote is configured, rather than listing all of history', async () => {
    // Nothing to be behind. Reporting every commit as unpushed would show a permanent warning
    // on a repo that is deliberately local.
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');

    expect(await git.unpushedCommits()).toEqual([]);
  });
});

describe('GitSyncer.retryUnpushed', () => {
  it('publishes what was pending once the remote comes back', async () => {
    // Possible only because the deploy key works unattended: no logged-in user is involved.
    const repo = await newRepo();
    const remote = await repo.addRemote();
    repos.push(remote);
    await repo.breakRemote();
    const git = new GitRepository(repo.dir);
    const sha = await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');
    await git.push();
    await repo.git('remote', 'set-url', 'origin', remote);

    const result = await new GitSyncer(git).retryUnpushed();

    expect(result.pushed).toBe(true);
    expect(await repo.git('ls-remote', remote, 'refs/heads/main')).toContain(sha);
    expect(await git.unpushedCommits()).toEqual([]);
  });

  it('does nothing when there is nothing pending', async () => {
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    const git = new GitRepository(repo.dir);

    expect(await new GitSyncer(git).retryUnpushed()).toEqual({ pushed: false, commits: 0 });
  });

  it('stays quiet when the remote is still down', async () => {
    // Runs on a timer. Throwing here would produce an unhandled rejection every interval for
    // the length of a GitHub outage.
    const repo = await newRepo();
    repos.push(await repo.addRemote());
    await repo.breakRemote();
    const git = new GitRepository(repo.dir);
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'change');

    await expect(new GitSyncer(git).retryUnpushed()).resolves.toMatchObject({ pushed: false });
  });

  it('reports how many commits it published', async () => {
    const repo = await newRepo();
    const remote = await repo.addRemote();
    repos.push(remote);
    await repo.breakRemote();
    const git = new GitRepository(repo.dir);
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'first');
    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 2\n' }, 'second');
    await repo.git('remote', 'set-url', 'origin', remote);

    expect(await new GitSyncer(git).retryUnpushed()).toEqual({ pushed: true, commits: 2 });
  });
});

describe('buildSshCommand', () => {
  it('points ssh at the deploy key', () => {
    expect(buildSshCommand({ keyPath: '/run/secrets/deploy_key' })).toContain(
      '-i /run/secrets/deploy_key',
    );
  });

  it('uses only that key, ignoring any agent or default identity', () => {
    // Without IdentitiesOnly, ssh offers every key it can find and may authenticate as whoever
    // the box's own key belongs to — which would work in dev and fail confusingly in prod.
    expect(buildSshCommand({ keyPath: '/k' })).toContain('IdentitiesOnly=yes');
  });

  it('keeps host key checking on', () => {
    // Turning it off is the usual shortcut and it removes the only protection against pushing
    // config, including the repository's whole history, to an impostor of github.com.
    const command = buildSshCommand({ keyPath: '/k' });

    expect(command).toContain('StrictHostKeyChecking=yes');
    expect(command).not.toContain('StrictHostKeyChecking=no');
    expect(command).not.toContain('/dev/null');
  });

  it('reads known hosts from the path it is given', () => {
    expect(buildSshCommand({ keyPath: '/k', knownHostsPath: '/etc/config/known_hosts' })).toContain(
      'UserKnownHostsFile=/etc/config/known_hosts',
    );
  });
});
