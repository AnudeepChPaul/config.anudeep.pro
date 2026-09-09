import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where the local repository comes from.
 *
 * Seeding invents a history, so a seeded repository shares no ancestor with the remote and can
 * never be pushed — `merge-base` returns nothing and publishing is stuck reporting "not yet
 * pushed" forever. Cloning is therefore the default whenever it can work, and seeding is the
 * fallback. The operator chose that ANY failure falls back to seeding, so the decision must at
 * least say out loud which reason applied: a silent fallback is how the divergence appeared.
 */
const script = join(process.cwd(), 'scripts', 'repo-provenance.sh');

const decide = (env: Record<string, string>, seeded = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'provenance-'));
  const repo = join(dir, 'repo');
  if (seeded) mkdirSync(join(repo, '.git'), { recursive: true });
  return execFileSync(script, [repo], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  }).trim();
};

describe('deciding where the repository comes from', () => {
  it('clones when a remote and an age key are both configured', () => {
    expect(
      decide({ CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: 'AGE-SECRET-KEY-1' }),
    ).toBe('clone');
  });

  it('seeds when no remote is configured', () => {
    expect(decide({ CONFIG_GIT_REMOTE: '', CONFIG_AGE_KEY: 'AGE-SECRET-KEY-1' })).toMatch(/^seed /);
  });

  // A clone whose secrets cannot be decrypted is a console that looks broken rather than
  // unconfigured, so the age key is a precondition of cloning, not a detail discovered later.
  it('seeds when a remote is set but no age key is', () => {
    expect(decide({ CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: '' })).toMatch(
      /^seed /,
    );
  });

  it('says why it fell back, so the divergence is never silent', () => {
    expect(decide({ CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: '' })).toContain(
      'age key',
    );
    expect(decide({ CONFIG_GIT_REMOTE: '', CONFIG_AGE_KEY: 'k' })).toContain('remote');
  });

  it('keeps a repository that already exists, whatever is configured', () => {
    expect(decide({ CONFIG_GIT_REMOTE: 'git@github.com:a/b.git', CONFIG_AGE_KEY: 'k' }, true)).toBe(
      'keep',
    );
  });
});
