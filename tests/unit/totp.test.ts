import { generateTotp, totpCounter, verifyTotp } from '@config/src/auth/totp.js';
import { describe, expect, it } from 'vitest';

/**
 * TOTP, checked against the RFC 6238 test vectors.
 *
 * Written here rather than pulled in, because the whole dependency is thirty lines of HMAC and
 * a counter — but that means it must be checked against the published vectors, not against
 * itself. A TOTP implementation that agrees with its own generator and with nothing else looks
 * perfect in tests and rejects every code from the operator's phone.
 */

/** RFC 6238 Appendix B: the ASCII seed "12345678901234567890", hex-encoded. */
const SHA1_SECRET = Buffer.from('12345678901234567890', 'ascii');

/** [unix time, expected 8-digit code] from the SHA-1 rows of the RFC's table. */
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('generateTotp against RFC 6238', () => {
  for (const [time, expected] of VECTORS) {
    it(`matches the published code at t=${time}`, () => {
      expect(generateTotp(SHA1_SECRET, { counter: totpCounter(time), digits: 8 })).toBe(expected);
    });
  }

  it('produces the six digits an authenticator app shows', () => {
    // The RFC's vectors are eight digits; every authenticator in practice shows six, which is
    // the last six of the same value.
    expect(generateTotp(SHA1_SECRET, { counter: totpCounter(59), digits: 6 })).toBe('287082');
  });

  it('pads a code whose value is short', () => {
    // A code is a fixed-width string, not a number. Dropping a leading zero would make one code
    // in ten fail to match, intermittently, forever.
    const code = generateTotp(Buffer.from('x'), { counter: 1, digits: 6 });

    expect(code).toHaveLength(6);
  });
});

describe('totpCounter', () => {
  it('advances once every thirty seconds', () => {
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(29)).toBe(0);
    expect(totpCounter(30)).toBe(1);
    expect(totpCounter(59)).toBe(1);
  });
});

describe('verifyTotp', () => {
  const at = (time: number) => ({ now: time, secret: SHA1_SECRET, digits: 6 });

  it('accepts the current code', () => {
    const code = generateTotp(SHA1_SECRET, { counter: totpCounter(1111111109), digits: 6 });

    expect(verifyTotp(code, at(1111111109)).ok).toBe(true);
  });

  it('accepts a code from the previous step, for a slow typist and a slow clock', () => {
    // Rejecting the immediately previous step makes break-glass unusable for anyone who starts
    // typing at second 28. One step of tolerance is the usual compromise.
    const code = generateTotp(SHA1_SECRET, { counter: totpCounter(1111111109) - 1, digits: 6 });

    expect(verifyTotp(code, at(1111111109)).ok).toBe(true);
  });

  it('rejects a code from further back than the tolerated window', () => {
    const code = generateTotp(SHA1_SECRET, { counter: totpCounter(1111111109) - 5, digits: 6 });

    expect(verifyTotp(code, at(1111111109)).ok).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp('000000', at(1111111109)).ok).toBe(false);
  });

  it('rejects a code of the wrong length rather than comparing a prefix', () => {
    expect(verifyTotp('0708', at(1111111109)).ok).toBe(false);
  });

  it('reports which counter matched, so a replay can be refused', () => {
    const counter = totpCounter(1111111109);
    const code = generateTotp(SHA1_SECRET, { counter, digits: 6 });

    const result = verifyTotp(code, at(1111111109));

    expect(result.ok && result.counter).toBe(counter);
  });

  it('refuses a counter that has already been used', () => {
    // A TOTP code stays valid for its whole step. Without this, anyone who saw the code — over
    // a shoulder, in a screen share, in a proxy log — can reuse it for the rest of that window,
    // and break-glass is the one login where that matters most.
    const counter = totpCounter(1111111109);
    const code = generateTotp(SHA1_SECRET, { counter, digits: 6 });

    const result = verifyTotp(code, { ...at(1111111109), lastUsedCounter: counter });

    expect(result.ok).toBe(false);
  });

  it('still accepts a newer code after an earlier one was used', () => {
    const counter = totpCounter(1111111109);
    const code = generateTotp(SHA1_SECRET, { counter, digits: 6 });

    const result = verifyTotp(code, { ...at(1111111109), lastUsedCounter: counter - 1 });

    expect(result.ok).toBe(true);
  });
});
