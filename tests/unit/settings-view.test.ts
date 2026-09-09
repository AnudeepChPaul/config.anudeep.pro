import { renderSettings } from '@config/src/views/pages.js';
import { settingsRows } from '@config/src/views/settings.js';
import { describe, expect, it } from 'vitest';

/**
 * What the settings page may show.
 *
 * The page exists because a misconfiguration had no symptom: CONFIG_GIT_REMOTE was empty and
 * publishing simply reported "not yet pushed" forever, and CONFIG_AGE_KEY held a public recipient
 * rather than a secret key for hours with nothing on screen to say so.
 *
 * It is also the one page that reads the process environment, so it is the one page that can leak
 * everything at once. The age key alone decrypts the whole registry, and the session secret forges
 * any operator. A value is masked by CLASSIFICATION, never by remembering to mask it at the call
 * site: a variable added later is secret because its name says so, not because someone noticed.
 */
const ALL: NodeJS.ProcessEnv = {
  CONFIG_AGE_KEY: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQZZZZZZZ',
  CONFIG_SESSION_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  CONFIG_IAM_CLIENT_SECRET: 'super-secret-client-value',
  CONFIG_WEBHOOK_SECRET: 'webhook-secret-value',
  CONFIG_GIT_REMOTE: 'git@github.com:AnudeepChPaul/config.bare.anudeep.pro.git',
  CONFIG_REPO_DIR: '/var/lib/config/repo',
  CONFIG_ENVIRONMENT: 'dev',
};

const SECRET_VALUES = [
  ALL.CONFIG_AGE_KEY,
  ALL.CONFIG_SESSION_SECRET,
  ALL.CONFIG_IAM_CLIENT_SECRET,
  ALL.CONFIG_WEBHOOK_SECRET,
] as string[];

describe('the settings rows', () => {
  it('never carries a secret value, whole or in part beyond a short prefix', () => {
    for (const row of settingsRows(ALL)) {
      if (!row.secret) continue;
      const shown = String(row.shown);
      for (const secret of SECRET_VALUES) {
        expect(shown === secret, row.name).toBe(false);
        // A prefix is allowed; anything approaching the value is not.
        expect(shown.length, row.name).toBeLessThan(secret.length);
      }
    }
  });

  it('classifies by name, so a variable added later is secret without anyone remembering', () => {
    const secrets = settingsRows(ALL)
      .filter((row) => row.secret)
      .map((row) => row.name);

    expect(secrets).toContain('CONFIG_AGE_KEY');
    expect(secrets).toContain('CONFIG_SESSION_SECRET');
    expect(secrets).toContain('CONFIG_IAM_CLIENT_SECRET');
    expect(secrets).toContain('CONFIG_WEBHOOK_SECRET');
  });

  it('shows an ordinary value in full, which is the point of the page', () => {
    const remote = settingsRows(ALL).find((row) => row.name === 'CONFIG_GIT_REMOTE');
    expect(remote?.shown).toBe(ALL.CONFIG_GIT_REMOTE);
  });

  // The failure this page was built for: something unset that nothing else reports.
  it('says when a variable is not set at all', () => {
    const rows = settingsRows({});
    const remote = rows.find((row) => row.name === 'CONFIG_GIT_REMOTE');
    expect(remote?.set).toBe(false);
    expect(String(remote?.shown)).not.toContain('undefined');
  });

  it('reports a secret that is set without revealing it', () => {
    const key = settingsRows(ALL).find((row) => row.name === 'CONFIG_AGE_KEY');
    expect(key?.set).toBe(true);
    expect(String(key?.shown)).not.toContain('ZZZZZZZ');
  });
});

describe('the rendered settings page', () => {
  it('puts no secret value in the markup, by any route', () => {
    const body = String(renderSettings({ env: ALL, fragment: true }));
    for (const secret of SECRET_VALUES) {
      expect(body.includes(secret), secret.slice(0, 12)).toBe(false);
    }
  });

  it('names every variable it knows about', () => {
    const body = String(renderSettings({ env: ALL, fragment: true }));
    expect(body).toContain('CONFIG_GIT_REMOTE');
    expect(body).toContain('CONFIG_AGE_KEY');
  });
});
