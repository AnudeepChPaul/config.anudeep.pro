import { rm } from 'node:fs/promises';
import { GitRepository } from '@config/src/git/repository.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TestRepo } from '../helpers.js';

/**
 * The read half of the git engine.
 *
 * `readTree` is what every service read is ultimately served from, so its contract is narrow and
 * strict: it returns the configuration **as committed**, together with the sha it read at. The
 * sha is not decoration — slice 7's stale-commit check is the only concurrency control git gives
 * us, and it is only as good as the sha a read reports.
 */

const repos: TestRepo[] = [];
const newRepo = async () => {
  const repo = await TestRepo.create();
  repos.push(repo);
  return repo;
};

afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => rm(r.dir, { recursive: true, force: true })));
});

describe('GitRepository.headCommit', () => {
  it('reports the sha git reports', async () => {
    const repo = await newRepo();
    const sha = await repo.commit({ 'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\n' });

    expect(await new GitRepository(repo.dir).headCommit()).toBe(sha);
  });

  it('moves with each commit', async () => {
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);

    await repo.commit({ 'config/iam/prod.yaml': 'A: 1\n' });
    const first = await git.headCommit();
    await repo.commit({ 'config/iam/prod.yaml': 'A: 2\n' });

    expect(await git.headCommit()).not.toBe(first);
  });
});

describe('GitRepository.readSources', () => {
  it('keys every config file by its service/environment namespace', async () => {
    const repo = await newRepo();
    await repo.commit({
      'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\n',
      'config/iam/dev.yaml': 'MFA_ENFORCEMENT: optional\n',
      'config/api/prod.yaml': 'RATE_LIMIT: 100\n',
    });

    const { sources } = await new GitRepository(repo.dir).readSources();

    expect([...sources.keys()].sort()).toEqual(['api/prod', 'iam/dev', 'iam/prod']);
  });

  it('returns the file text as committed, without interpreting it', async () => {
    // Parsing belongs to the loader, after decryption. If this method parsed, it would have to
    // parse ciphertext — and an encrypted file is not the document it will become.
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\n' });

    const { sources } = await new GitRepository(repo.dir).readSources();

    expect(sources.get('iam/prod')).toBe('MFA_ENFORCEMENT: all\n');
  });

  it('reports the commit it read at', async () => {
    const repo = await newRepo();
    const sha = await repo.commit({ 'config/iam/prod.yaml': 'A: 1\n' });

    expect((await new GitRepository(repo.dir).readSources()).commit).toBe(sha);
  });

  it('reads committed state, ignoring an uncommitted working-tree edit', async () => {
    // The single most important property in this file. A pull, a half-finished editor save, or
    // a crashed write all leave the working tree dirty; serving from it would hand services
    // configuration that no commit records and no audit trail explains.
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod.yaml': 'MFA_ENFORCEMENT: all\n' });
    await repo.write('config/iam/prod.yaml', 'MFA_ENFORCEMENT: optional\n');

    const { sources } = await new GitRepository(repo.dir).readSources();

    expect(sources.get('iam/prod')).toContain('all');
  });

  it('does not see an untracked file that was never committed', async () => {
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod.yaml': 'A: 1\n' });
    await repo.write('config/rogue/prod.yaml', 'B: 2\n');

    const { sources } = await new GitRepository(repo.dir).readSources();

    expect(sources.has('rogue/prod')).toBe(false);
  });

  it('reads only config/, leaving schema and sops files alone', async () => {
    const repo = await newRepo();
    await repo.commit({
      'config/iam/prod.yaml': 'A: 1\n',
      'schema/iam.yaml': 'A: {type: int}\n',
      '.sops.yaml': 'creation_rules: []\n',
      'services.yaml': 'services: []\n',
    });

    const { sources } = await new GitRepository(repo.dir).readSources();

    expect([...sources.keys()]).toEqual(['iam/prod']);
  });

  it('ignores non-YAML files inside config/', async () => {
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod.yaml': 'A: 1\n', 'config/iam/README.md': '# notes\n' });

    const { sources } = await new GitRepository(repo.dir).readSources();

    expect([...sources.keys()]).toEqual(['iam/prod']);
  });

  it('returns nothing for a repo with no config directory', async () => {
    // A fresh repo must not crash the service on boot; there is simply nothing to override.
    const repo = await newRepo();

    const { commit, sources } = await new GitRepository(repo.dir).readSources();

    expect(sources.size).toBe(0);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects a config file nested deeper than service/environment', async () => {
    // Silently skipping it would mean an operator edits a file, sees a green commit, and the
    // value never reaches anything.
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod/extra.yaml': 'A: 1\n' });

    await expect(new GitRepository(repo.dir).readSources()).rejects.toThrow(
      /config\/iam\/prod\/extra\.yaml/,
    );
  });
});

describe('GitRepository.readSchemas', () => {
  it('keys every schema file by its service name', async () => {
    const repo = await newRepo();
    await repo.commit({
      'schema/iam.yaml': 'keys:\n  A:\n    type: int\n',
      'schema/api.yaml': 'keys:\n  B:\n    type: bool\n',
    });

    const schemas = await new GitRepository(repo.dir).readSchemas();

    expect(Object.keys(schemas).sort()).toEqual(['api', 'iam']);
    expect(schemas.iam).toContain('type: int');
  });

  it('reads schemas as committed, not as edited in the working tree', async () => {
    const repo = await newRepo();
    await repo.commit({ 'schema/iam.yaml': 'keys:\n  A:\n    type: int\n' });
    await repo.write('schema/iam.yaml', 'keys: {}\n');

    const schemas = await new GitRepository(repo.dir).readSchemas();

    expect(schemas.iam).toContain('type: int');
  });

  it('returns nothing for a repo with no schema directory', async () => {
    const repo = await newRepo();

    expect(await new GitRepository(repo.dir).readSchemas()).toEqual({});
  });

  it('rejects a schema file nested below the service level', async () => {
    const repo = await newRepo();
    await repo.commit({ 'schema/iam/extra.yaml': 'keys: {}\n' });

    await expect(new GitRepository(repo.dir).readSchemas()).rejects.toThrow(
      /schema\/iam\/extra\.yaml/,
    );
  });
});

describe('GitRepository.writeAndCommit', () => {
  it('commits a new namespace file and returns the new sha', async () => {
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);
    const before = await git.headCommit();

    const sha = await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'add iam config');

    expect(sha).not.toBe(before);
    expect(sha).toBe(await git.headCommit());
    expect((await git.readSources()).sources.get('iam/prod')).toBe('A: 1\n');
  });

  it('creates the directories a new service needs', async () => {
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);

    await git.writeAndCommit({ 'config/brandnew/prod.yaml': 'A: 1\n' }, 'add service');

    expect((await git.readSources()).sources.has('brandnew/prod')).toBe(true);
  });

  it('overwrites an existing file rather than appending to it', async () => {
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod.yaml': 'A: 1\nB: 2\n' });
    const git = new GitRepository(repo.dir);

    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 9\n' }, 'drop B');

    expect((await git.readSources()).sources.get('iam/prod')).toBe('A: 9\n');
  });

  it('deletes a file when given null', async () => {
    // Removing a namespace entirely is a legitimate operation; leaving an empty file behind
    // would keep serving an empty override where the service expects nothing at all.
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod.yaml': 'A: 1\n', 'config/api/prod.yaml': 'B: 2\n' });
    const git = new GitRepository(repo.dir);

    await git.writeAndCommit({ 'config/iam/prod.yaml': null }, 'remove iam/prod');

    const { sources } = await git.readSources();
    expect(sources.has('iam/prod')).toBe(false);
    expect(sources.has('api/prod')).toBe(true);
  });

  it('writes the message verbatim, trailers included', async () => {
    // The message is the audit record. Anything git or the shell mangles here is lost.
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);
    const message =
      'Set MFA\n\nActor: me@anudeep.pro\nKey: MFA_ENFORCEMENT\nOld-Value-Hash: sha256:aa';

    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, message);

    expect(await repo.git('log', '-1', '--format=%B')).toBe(message);
  });

  it('leaves git able to parse the trailers back out', async () => {
    // If the format is right, `git log --format=%(trailers)` recovers the attribution — which
    // is what makes the history queryable rather than just readable.
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);

    await git.writeAndCommit(
      { 'config/iam/prod.yaml': 'A: 1\n' },
      'Set MFA\n\nActor: me@anudeep.pro\nKey: MFA_ENFORCEMENT',
    );

    const trailers = await repo.git('log', '-1', '--format=%(trailers:key=Actor,valueonly)');
    expect(trailers.trim()).toBe('me@anudeep.pro');
  });

  it('commits several files as one change', async () => {
    // One save, one commit. Two commits would make a partial rollback possible and would show
    // an intermediate state that no operator ever chose.
    const repo = await newRepo();
    const git = new GitRepository(repo.dir);
    const before = await repo.git('rev-list', '--count', 'HEAD');

    await git.writeAndCommit(
      { 'config/iam/prod.yaml': 'A: 1\n', 'config/api/prod.yaml': 'B: 2\n' },
      'two namespaces',
    );

    expect(Number(await repo.git('rev-list', '--count', 'HEAD'))).toBe(Number(before) + 1);
  });

  it('touches nothing it was not asked to change', async () => {
    const repo = await newRepo();
    await repo.commit({ 'config/api/prod.yaml': 'B: 2\n', 'schema/api.yaml': 'keys: {}\n' });
    const git = new GitRepository(repo.dir);

    await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'add iam');

    const changed = await repo.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD');
    expect(changed.split('\n')).toEqual(['config/iam/prod.yaml']);
  });

  it('makes no commit when nothing actually changed', async () => {
    // Saving a value identical to the current one should not fill the history with empty
    // commits that a reviewer then has to read.
    const repo = await newRepo();
    await repo.commit({ 'config/iam/prod.yaml': 'A: 1\n' });
    const git = new GitRepository(repo.dir);
    const before = await git.headCommit();

    const sha = await git.writeAndCommit({ 'config/iam/prod.yaml': 'A: 1\n' }, 'no-op');

    expect(sha).toBe(before);
  });
});
