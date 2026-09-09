import { loadConfig } from '@config/src/config.js';
import { describe, expect, it } from 'vitest';

/** What every environment now requires, so a test can say what it is actually asserting. */
const secrets = () => ({ CONFIG_AGE_KEY: 'age-key', CONFIG_SESSION_SECRET: 'session-secret' });

/**
 * The remote and its key come from the environment, like everything else this service needs to
 * start: it cannot read its own registry to find out where its registry is.
 */
describe('the git remote', () => {
  it('is null by default, which keeps a local registry local', () => {
    expect(loadConfig({ CONFIG_ENVIRONMENT: 'dev', ...secrets() }).gitRemote).toBeNull();
  });

  it('is taken from CONFIG_GIT_REMOTE', () => {
    const config = loadConfig({
      ...secrets(),
      CONFIG_ENVIRONMENT: 'dev',
      CONFIG_GIT_REMOTE: 'git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git',
    });

    expect(config.gitRemote).toContain('config.bare.anudeep.pro');
  });

  it('carries the deploy key and its known_hosts, so ssh is not left guessing', () => {
    const config = loadConfig({
      ...secrets(),
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
      ...secrets(),
      CONFIG_GIT_REMOTE: 'git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git',
    });

    expect(config.repoWebUrl).toBe('https://github.com/AnudeepChPaul/config.bare.anudeep.pro');
  });

  it('can be told the browser address on its own, for a registry that pushes nowhere yet', () => {
    // Linking the commit is a read; it does not need a deploy key or a configured push.
    const config = loadConfig({
      ...secrets(),
      CONFIG_REPO_WEB_URL: 'https://github.com/AnudeepChPaul/config.bare.anudeep.pro',
    });

    expect(config.gitRemote).toBeNull();
    expect(config.repoWebUrl).toBe('https://github.com/AnudeepChPaul/config.bare.anudeep.pro');
  });

  it('is null when neither is set, and the console renders the sha as plain text', () => {
    expect(loadConfig({ ...secrets() }).repoWebUrl).toBeNull();
  });

  it('has no ssh options at all without a key, rather than half of them', () => {
    // Half-configured ssh is worse than none: git would fall back to whatever key the box
    // happens to hold and authenticate as somebody else.
    expect(
      loadConfig({ ...secrets(), CONFIG_GIT_KNOWN_HOSTS: '/etc/ssh/known_hosts' }).ssh,
    ).toBeNull();
  });
});

/**
 * No single value may switch off authentication.
 *
 * Every production protection was keyed off CONFIG_ENVIRONMENT, and `??` only falls back on
 * undefined — so an empty string, which is what an unset compose interpolation produces, was
 * neither dev nor prod. The age key stopped being required, the session secret stopped being
 * required, which made the auth options undefined, which buildWebApp only refuses when the
 * environment is exactly prod. The console came up with no login at all.
 */
describe('the environment name', () => {
  it('is one of three, or the service refuses to start', () => {
    expect(() => loadConfig({ CONFIG_ENVIRONMENT: '', ...secrets() })).toThrow(/environment/i);
    expect(() => loadConfig({ CONFIG_ENVIRONMENT: 'production', ...secrets() })).toThrow(
      /environment/i,
    );
  });

  it('accepts the three it knows, and defaults to dev when nothing is set', () => {
    for (const environment of ['dev', 'staging', 'prod']) {
      expect(loadConfig({ CONFIG_ENVIRONMENT: environment, ...secrets() }).environment).toBe(
        environment,
      );
    }
    expect(loadConfig({ ...secrets() }).environment).toBe('dev');
  });
});

describe('the guards do not depend on it', () => {
  it('requires a session secret in every environment, not only prod', () => {
    // Its absence is what made the auth options undefined, and an undefined auth is what
    // buildWebApp used to allow outside prod.
    expect(() => loadConfig({ CONFIG_ENVIRONMENT: 'dev', CONFIG_AGE_KEY: 'k' })).toThrow(
      /CONFIG_SESSION_SECRET/,
    );
  });

  it('requires an age key in every environment: without it nothing can be decrypted', () => {
    expect(() => loadConfig({ CONFIG_ENVIRONMENT: 'dev', CONFIG_SESSION_SECRET: 's' })).toThrow(
      /CONFIG_AGE_KEY/,
    );
  });

  it('marks the session cookie secure unless that is explicitly given up', () => {
    expect(loadConfig({ CONFIG_ENVIRONMENT: 'dev', ...secrets() }).insecureCookie).toBe(false);
    expect(
      loadConfig({ CONFIG_ENVIRONMENT: 'dev', CONFIG_INSECURE_COOKIE: '1', ...secrets() })
        .insecureCookie,
    ).toBe(true);
  });

  it('will not give up the secure cookie in prod, whatever is asked for', () => {
    // The opt-out exists for a developer on plain http, and for nobody else.
    expect(
      loadConfig({ CONFIG_ENVIRONMENT: 'prod', CONFIG_INSECURE_COOKIE: '1', ...secrets() })
        .insecureCookie,
    ).toBe(false);
  });
});

/**
 * The settings page is off unless it is switched on, and its allowlist is a list of people.
 *
 * The page shows a map of the deployment, so its default has to be "not there". A toggle that
 * defaults on, or an allowlist that is empty-means-everyone, would each turn a convenience into a
 * disclosure the first time someone deployed without reading the documentation.
 */
describe('the settings gate', () => {
  it('is off when nothing says otherwise', () => {
    expect(loadConfig({ ...secrets() }).enableSettings).toBe(false);
  });

  it('is on only for values that plainly mean on', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes']) {
      expect(
        loadConfig({ ...secrets(), CONFIG_ENABLE_SETTINGS: value }).enableSettings,
        value,
      ).toBe(true);
    }
  });

  // "false" reading as true is the classic way a flag ends up on in production.
  it('stays off for anything that does not', () => {
    for (const value of ['', '0', 'false', 'no', 'off', 'maybe']) {
      expect(
        loadConfig({ ...secrets(), CONFIG_ENABLE_SETTINGS: value }).enableSettings,
        value,
      ).toBe(false);
    }
  });

  it('reads the allowlist as addresses, trimmed, ignoring the empties', () => {
    const config = loadConfig({
      ...secrets(),
      CONFIG_SETTINGS_ALLOW: ' me@anudeep.pro , ops@anudeep.pro ,,',
    });

    expect(config.settingsAllow).toEqual(['me@anudeep.pro', 'ops@anudeep.pro']);
  });

  it('is an empty list when unset, which admits nobody rather than everybody', () => {
    expect(loadConfig({ ...secrets() }).settingsAllow).toEqual([]);
  });

  // An address is compared against a session's email; case is not identity.
  it('lowercases the list, so Me@ and me@ are the same person', () => {
    expect(
      loadConfig({ ...secrets(), CONFIG_SETTINGS_ALLOW: 'Me@Anudeep.PRO' }).settingsAllow,
    ).toEqual(['me@anudeep.pro']);
  });
});
