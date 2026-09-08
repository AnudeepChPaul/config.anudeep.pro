import { webUrlFor } from '@config/src/git/repository.js';
import { describe, expect, it } from 'vitest';

/**
 * The commit the console is serving, as a link to the commit on GitHub.
 *
 * The push remote is an SSH URL and the browser needs an HTTPS one, so this converts. Anything
 * it does not recognise returns null and the console renders the sha as plain text: a wrong
 * link is worse than none, because it sends an operator mid-incident to somebody else's
 * repository.
 */
describe('webUrlFor', () => {
  it('converts the scp-style ssh remote git pushes with', () => {
    expect(webUrlFor('git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git')).toBe(
      'https://github.com/AnudeepChPaul/config.bare.anudeep.pro',
    );
  });

  it('converts an ssh:// url, and one without the .git suffix', () => {
    expect(webUrlFor('ssh://git@github.com/AnudeepChPaul/config')).toBe(
      'https://github.com/AnudeepChPaul/config',
    );
  });

  it('keeps an https remote, dropping the suffix and any credentials in it', () => {
    expect(webUrlFor('https://x-access-token:secret@github.com/Anudeep/config.git')).toBe(
      'https://github.com/Anudeep/config',
    );
  });

  it('is null for a local path, which has no web address at all', () => {
    expect(webUrlFor('/var/lib/config/remote.git')).toBeNull();
    expect(webUrlFor(null)).toBeNull();
  });

  it('is null for a host it cannot build a commit url for', () => {
    // A self-hosted git over ssh may serve no web UI, and guessing github's path layout for it
    // produces a link that 404s at best.
    expect(webUrlFor('git@git.internal:ops/config.git')).toBeNull();
  });
});
