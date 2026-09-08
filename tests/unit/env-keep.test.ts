import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `make reset` used to `rm -f .env`, which threw away the two settings nobody can regenerate:
 * the git remote and the path to the deploy key. Every reset therefore disarmed publishing
 * silently — the console came back up local-only, and the deploy key mount became a directory
 * again because compose fell back to a path that does not exist.
 *
 * Generated dev state (the session secret, the age key for a volume that no longer exists) must
 * still go: keeping an age key whose repository was deleted is worse than having none.
 */
const script = join(process.cwd(), 'scripts', 'env-keep.sh');

const run = (contents: string, keep: string[] = ['CONFIG_GIT_REMOTE', 'CONFIG_DEPLOY_KEY']) => {
  const file = join(mkdtempSync(join(tmpdir(), 'env-keep-')), '.env');
  writeFileSync(file, contents);
  execFileSync(script, [file, ...keep]);
  return readFileSync(file, 'utf8');
};

describe('pruning the dev env file', () => {
  it('keeps the settings the operator supplied', () => {
    const out = run('CONFIG_SESSION_SECRET=abc\nCONFIG_GIT_REMOTE=git@github.com:a/b.git\n');
    expect(out).toContain('CONFIG_GIT_REMOTE=git@github.com:a/b.git');
  });

  it('drops the state tied to the volume that was just deleted', () => {
    const out = run('CONFIG_AGE_KEY=AGE-SECRET-KEY-1\nCONFIG_GIT_REMOTE=git@github.com:a/b.git\n');
    expect(out).not.toContain('AGE-SECRET-KEY-1');
  });

  // An empty setting is what dev-up.sh writes as a placeholder. Carrying it over is harmless,
  // but carrying it over as if it were a value hides that publishing is still unconfigured.
  it('does not carry an empty placeholder across', () => {
    const out = run('CONFIG_DEPLOY_KEY=\nCONFIG_GIT_REMOTE=git@github.com:a/b.git\n');
    expect(out).not.toMatch(/^CONFIG_DEPLOY_KEY=$/m);
  });

  it('leaves a file with nothing worth keeping empty rather than absent', () => {
    const out = run('CONFIG_SESSION_SECRET=abc\n');
    expect(out.trim()).toBe('');
  });

  it('keeps a value containing an equals sign whole', () => {
    const out = run('CONFIG_GIT_REMOTE=ssh://x/y?a=b\n');
    expect(out).toContain('CONFIG_GIT_REMOTE=ssh://x/y?a=b');
  });
});
