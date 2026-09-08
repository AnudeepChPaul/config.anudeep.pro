import { type Session, SessionCodec } from '@config/src/auth/session.js';
import { describe, expect, it } from 'vitest';

/**
 * The session cookie.
 *
 * It is the only thing standing between a browser and a page that can close registration for
 * the whole platform, and it travels through the one place an attacker can edit freely. So it
 * carries a signature, and every property here is about what happens when someone changes it.
 */

const SECRET = 'a'.repeat(64);
const NOW = 1_700_000_000_000;

const session: Session = {
  email: 'me@anudeep.pro',
  id: '7f3a1c9e',
  via: 'iam',
  expiresAt: NOW + 3_600_000,
};

const codec = (secret = SECRET) => new SessionCodec(secret, () => NOW);

describe('SessionCodec round trip', () => {
  it('reads back what it wrote', () => {
    const c = codec();

    expect(c.verify(c.sign(session))).toEqual(session);
  });

  it('keeps which credential was used', () => {
    // The UI shows a standing banner for a break-glass session, and the commit trailer records
    // it. Losing this would make the two indistinguishable after the fact.
    const c = codec();
    const breakGlass: Session = { ...session, via: 'break-glass' };

    expect(c.verify(c.sign(breakGlass))?.via).toBe('break-glass');
  });
});

describe('SessionCodec rejects what it did not sign', () => {
  it('rejects a payload edited in the browser', () => {
    // The whole reason for the signature: the cookie is editable by whoever holds it.
    const c = codec();
    const [payload, signature] = c.sign(session).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...session, email: 'attacker@example.com' }),
      'utf8',
    ).toString('base64url');

    expect(payload).toBeTruthy();
    expect(c.verify(`${forged}.${signature}`)).toBeNull();
  });

  it('rejects a signature made with a different secret', () => {
    const forged = codec('b'.repeat(64)).sign(session);

    expect(codec().verify(forged)).toBeNull();
  });

  it('rejects a cookie with no signature at all', () => {
    const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');

    expect(codec().verify(payload)).toBeNull();
  });

  it('rejects an empty or malformed cookie without throwing', () => {
    // Anything can arrive here — a truncated cookie, a stale one from another app on the same
    // host. None of them may take the process down.
    const c = codec();

    expect(c.verify('')).toBeNull();
    expect(c.verify('not.a.session')).toBeNull();
    expect(c.verify('....')).toBeNull();
  });

  it('rejects a session that expired', () => {
    const c = codec();
    const expired = c.sign({ ...session, expiresAt: NOW - 1 });

    expect(c.verify(expired)).toBeNull();
  });

  it('accepts one that expires in a moment', () => {
    const c = codec();

    expect(c.verify(c.sign({ ...session, expiresAt: NOW + 1 }))).not.toBeNull();
  });

  it('rejects a correctly signed session claiming an unrecognised credential', () => {
    // Deliberately signed with the real secret, because a mismatched signature would be caught
    // by the signature check and this assertion would prove nothing. An attacker cannot reach
    // here — this guards against a future code path that signs an unchecked string, which is
    // exactly how `via` would quietly stop meaning anything.
    const c = codec();
    const forged = c.sign({ ...session, via: 'trust-me' } as unknown as Session);

    expect(c.verify(forged)).toBeNull();
  });
});

describe('SessionCodec secret', () => {
  it('refuses to start with a secret short enough to guess', () => {
    // A signing key set to "dev" in a compose file is the same as no signature at all.
    expect(() => new SessionCodec('short', () => NOW)).toThrow(/secret/i);
  });
});

describe('cookie attributes', () => {
  it('is not readable from JavaScript', () => {
    // Anything script can read, an injected script can exfiltrate.
    expect(codec().cookieOptions().httpOnly).toBe(true);
  });

  it('is not sent on cross-site requests', () => {
    // The forms here are plain posts with no CSRF token, so SameSite is what stops another
    // site's page from submitting one on a logged-in operator's behalf.
    expect(codec().cookieOptions().sameSite).toBe('lax');
  });

  it('is https-only by default, in every environment', () => {
    // It used to be `environment === 'prod'`, so any value that was not exactly that — an empty
    // string included — sent the session cookie in the clear.
    expect(codec().cookieOptions().secure).toBe(true);
  });

  it('gives that up only where it is explicitly asked for', () => {
    // For a developer on plain http, and for nobody else: loadConfig refuses the opt-out in prod.
    expect(codec().cookieOptions(true).secure).toBe(false);
  });
});
