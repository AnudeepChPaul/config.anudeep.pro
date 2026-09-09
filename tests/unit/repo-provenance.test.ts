import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where the local repository comes from.
 *
 * Seeding invents a history, so a seeded repository shares no ancestor with the remote and can
 * never be pushed: `merge-base` returns nothing and publishing is stuck reporting "not yet
 * pushed" forever. That is the state this checkout was found in, and every reset recreated it.
 * The registry is therefore always cloned. Nothing falls back to a sample any more -- a fallback
 * is what made the divergence look like normal operation.
 */
const script = join(process.cwd(), 'scripts', 'repo-provenance.sh');

const decide = (env: Record<string, string>, seeded = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'provenance-'));
  const repo = join(dir, 'repo');
  if (seeded) mkdirSync(join(repo, '.git'), { recursive: true });
  try {
    return {
      out: execFileSync(script, [repo], {
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
      }).trim(),
      failed: false,
    };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim(), failed: true };
  }
};

describe('deciding where the repository comes from', () => {
  it('clones when a remote and an age key are both configured', () => {
    expect(
      decide({ CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: 'AGE-SECRET-KEY-1' })
        .out,
    ).toBe('clone');
  });

  it('keeps a repository that already exists', () => {
    expect(
      decide({ CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: 'k' }, true).out,
    ).toBe('keep');
  });

  // Stopping is the point. Seeding a sample instead produced a repository that looked fine and
  // could never be pushed, and nothing said so until someone went looking for merge-base.
  it('stops rather than inventing a history when no remote is configured', () => {
    const { out, failed } = decide({ CONFIG_GIT_REMOTE: '', CONFIG_AGE_KEY: 'k' });
    expect(failed).toBe(true);
    expect(out).toMatch(/remote/);
  });

  it('stops when a remote is set but no age key is, since the clone would not decrypt', () => {
    const { out, failed } = decide({
      CONFIG_GIT_REMOTE: 'git@github.com:a/b.git',
      CONFIG_AGE_KEY: '',
    });
    expect(failed).toBe(true);
    expect(out).toMatch(/age key/);
  });

  it('never answers with a seed', () => {
    for (const env of [
      { CONFIG_GIT_REMOTE: '', CONFIG_AGE_KEY: '' },
      { CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: '' },
      { CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: 'k' },
    ]) {
      expect(decide(env).out).not.toMatch(/^seed/);
    }
  });
});
