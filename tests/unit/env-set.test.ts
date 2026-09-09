import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Setting one value in the dev env file.
 *
 * `make reset` no longer touches .env, so a value that outlives the volume it describes is now
 * possible: reset deletes the repository, seeding generates a NEW age key, and .env still names
 * the old one. dev-up.sh used to append only when a key was missing, so the stale key survived
 * and every secret silently failed to decrypt. Seeding therefore has to overwrite.
 */
const script = join(process.cwd(), 'scripts', 'env-set.sh');

const run = (contents: string, key: string, value: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'env-set-')), '.env');
  writeFileSync(file, contents);
  execFileSync(script, [file, key, value]);
  return readFileSync(file, 'utf8');
};

describe('setting a value in the dev env file', () => {
  it('replaces a stale value rather than leaving it', () => {
    const out = run('CONFIG_AGE_KEY=OLD\n', 'CONFIG_AGE_KEY', 'NEW');
    expect(out).toContain('CONFIG_AGE_KEY=NEW');
    expect(out).not.toContain('OLD');
  });

  it('appends when the key is not there yet', () => {
    expect(run('CONFIG_GIT_REMOTE=x\n', 'CONFIG_AGE_KEY', 'NEW')).toContain('CONFIG_AGE_KEY=NEW');
  });

  it('leaves every other line alone', () => {
    const out = run(
      'CONFIG_GIT_REMOTE=git@github.com:a/b.git\nCONFIG_AGE_KEY=OLD\n',
      'CONFIG_AGE_KEY',
      'NEW',
    );
    expect(out).toContain('CONFIG_GIT_REMOTE=git@github.com:a/b.git');
  });

  it('replaces a key whose value is empty, which is what a placeholder looks like', () => {
    expect(run('CONFIG_AGE_KEY=\n', 'CONFIG_AGE_KEY', 'NEW')).toContain('CONFIG_AGE_KEY=NEW');
  });

  // An age key is base64-ish and a remote contains ':' and '/', so a value must never be
  // interpreted as part of the expression that writes it.
  it('writes a value containing slashes and colons verbatim', () => {
    const out = run('X=1\n', 'CONFIG_GIT_REMOTE', 'ssh://git@h:22/a/b.git');
    expect(out).toContain('CONFIG_GIT_REMOTE=ssh://git@h:22/a/b.git');
  });

  it('does not duplicate the key when run twice', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'env-set-')), '.env');
    writeFileSync(file, 'CONFIG_AGE_KEY=OLD\n');
    execFileSync(script, [file, 'CONFIG_AGE_KEY', 'A']);
    execFileSync(script, [file, 'CONFIG_AGE_KEY', 'B']);
    expect(readFileSync(file, 'utf8').match(/^CONFIG_AGE_KEY=/gm)).toHaveLength(1);
  });
});
