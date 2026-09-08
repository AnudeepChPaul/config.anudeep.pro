import { decodeBase32 } from '@config/src/auth/base32.js';
import { BreakGlass } from '@config/src/auth/break-glass.js';
import { generateTotp, totpCounter } from '@config/src/auth/totp.js';
import { buildBreakGlassRecord } from '@config/src/cli/bootstrap-breakglass.js';
import { describe, expect, it } from 'vitest';

/**
 * Minting the break-glass credential.
 *
 * A CLI rather than a page in the UI, because the UI is the thing this credential exists to
 * reach when nothing else works — bootstrapping it through the door it unlocks is circular.
 */

describe('buildBreakGlassRecord', () => {
  it('produces a record the gate accepts', async () => {
    // The only assertion that matters: what the CLI writes must be what the login path reads.
    // Everything else is detail.
    const { record, password } = await buildBreakGlassRecord('ops@anudeep.pro');
    const now = Math.floor(Date.now() / 1000);
    const gate = new BreakGlass({
      record,
      isIamReachable: async () => false,
      alert: () => {},
      now: () => now,
    });
    const code = generateTotp(decodeBase32(record.totpSecret), {
      counter: totpCounter(now),
      digits: 6,
    });

    expect((await gate.attempt(password, code)).ok).toBe(true);
  });

  it('does not store the password anywhere in the record', async () => {
    // The record is committed to a repository that is pushed to GitHub.
    const { record, password } = await buildBreakGlassRecord('ops@anudeep.pro');

    expect(JSON.stringify(record)).not.toContain(password);
  });

  it('generates the password rather than taking one', async () => {
    // A human-chosen password for the one credential that bypasses the identity provider is
    // the weakest link in the platform, and it is typed once a year at most.
    const first = await buildBreakGlassRecord('ops@anudeep.pro');
    const second = await buildBreakGlassRecord('ops@anudeep.pro');

    expect(first.password).not.toBe(second.password);
    expect(first.password.length).toBeGreaterThanOrEqual(24);
  });

  it('generates a different TOTP secret each time', async () => {
    const first = await buildBreakGlassRecord('ops@anudeep.pro');
    const second = await buildBreakGlassRecord('ops@anudeep.pro');

    expect(first.record.totpSecret).not.toBe(second.record.totpSecret);
  });

  it('produces a TOTP secret an authenticator app can read', async () => {
    // Base32, no padding, and long enough: 160 bits is what RFC 4226 recommends.
    const { record } = await buildBreakGlassRecord('ops@anudeep.pro');

    expect(record.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(decodeBase32(record.totpSecret).length).toBeGreaterThanOrEqual(20);
  });

  it('keeps the actor email that will appear in commits', async () => {
    const { record } = await buildBreakGlassRecord('ops@anudeep.pro');

    expect(record.actorEmail).toBe('ops@anudeep.pro');
  });

  it('offers an otpauth URI so the secret can be scanned rather than typed', async () => {
    const { otpauthUri, record } = await buildBreakGlassRecord('ops@anudeep.pro');
    const url = new URL(otpauthUri);

    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe(record.totpSecret);
    expect(url.searchParams.get('issuer')).toBe('config.anudeep.pro');
  });
});
