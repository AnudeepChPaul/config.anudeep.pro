import { loadConfig } from '@config/src/config.js';
import { describe, expect, it } from 'vitest';

/**
 * The remote and its key come from the environment, like everything else this service needs to
 * start: it cannot read its own registry to find out where its registry is.
 */
describe('the git remote', () => {
  it('is null by default, which keeps a local registry local', () => {
    expect(loadConfig({ CONFIG_ENVIRONMENT: 'dev' }).gitRemote).toBeNull();
  });

  it('is taken from CONFIG_GIT_REMOTE', () => {
    const config = loadConfig({
      CONFIG_ENVIRONMENT: 'dev',
      CONFIG_GIT_REMOTE: 'git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git',
    });

    expect(config.gitRemote).toContain('config.bare.anudeep.pro');
  });

  it('carries the deploy key and its known_hosts, so ssh is not left guessing', () => {
    const config = loadConfig({
      CONFIG_ENVIRONMENT: 'dev',
      CONFIG_GIT_SSH_KEY: '/run/secrets/deploy_key',
      CONFIG_GIT_KNOWN_HOSTS: '/etc/ssh/known_hosts',
    });

    expect(config.ssh).toEqual({
      keyPath: '/run/secrets/deploy_key',
      knownHostsPath: '/etc/ssh/known_hosts',
    });
  });

  it('takes the browser address from the remote, so a link needs no second setting', () => {
    const config = loadConfig({
      CONFIG_GIT_REMOTE: 'git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git',
    });

    expect(config.repoWebUrl).toBe('https://github.com/AnudeepChPaul/config.bare.anudeep.pro');
  });

  it('can be told the browser address on its own, for a registry that pushes nowhere yet', () => {
    // Linking the commit is a read; it does not need a deploy key or a configured push.
    const config = loadConfig({
      CONFIG_REPO_WEB_URL: 'https://github.com/AnudeepChPaul/config.bare.anudeep.pro',
    });

    expect(config.gitRemote).toBeNull();
    expect(config.repoWebUrl).toBe('https://github.com/AnudeepChPaul/config.bare.anudeep.pro');
  });

  it('is null when neither is set, and the console renders the sha as plain text', () => {
    expect(loadConfig({}).repoWebUrl).toBeNull();
  });

  it('has no ssh options at all without a key, rather than half of them', () => {
    // Half-configured ssh is worse than none: git would fall back to whatever key the box
    // happens to hold and authenticate as somebody else.
    expect(loadConfig({ CONFIG_GIT_KNOWN_HOSTS: '/etc/ssh/known_hosts' }).ssh).toBeNull();
  });
});
