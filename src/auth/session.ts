import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The session cookie.
 *
 * It is the only thing between a browser and a page that can close registration platform-wide,
 * and it travels through the one place an attacker edits freely — so it is signed, and anything
 * that does not verify is simply not a session.
 *
 * Stateless on purpose: there is no session store to run or back up, and this service already
 * refuses to depend on a database. The cost is that a session cannot be revoked before it
 * expires, which is why they are short.
 */

/** Below this a signing key is guessable, and a guessable key is the same as none. */
const MIN_SECRET_LENGTH = 32;

export type SessionVia = 'iam' | 'break-glass';

const VIA_VALUES: readonly string[] = ['iam', 'break-glass'];

export interface Session {
  readonly email: string;
  readonly id: string;
  /** Which credential signed this session in. Drives the banner and the commit attribution. */
  readonly via: SessionVia;
  readonly expiresAt: number;
}

export interface CookieOptions {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: '/';
}

export class SessionCodec {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`the session secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }

  sign(session: Session): string {
    const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
    return `${payload}.${this.mac(payload)}`;
  }

  /** The session, or null. Every failure is the same null: a bad cookie is simply not a session. */
  verify(cookie: string): Session | null {
    const [payload, signature, ...rest] = cookie.split('.');
    if (!payload || !signature || rest.length > 0) return null;
    if (!equals(signature, this.mac(payload))) return null;

    let parsed: Partial<Session>;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Session>;
    } catch {
      return null;
    }

    if (typeof parsed.email !== 'string' || typeof parsed.id !== 'string') return null;
    if (typeof parsed.expiresAt !== 'number') return null;
    // An unrecognised `via` would let a break-glass session present itself as an iam one,
    // losing both the standing banner and the attribution.
    if (typeof parsed.via !== 'string' || !VIA_VALUES.includes(parsed.via)) return null;
    if (parsed.expiresAt <= this.now()) return null;

    return {
      email: parsed.email,
      id: parsed.id,
      via: parsed.via as SessionVia,
      expiresAt: parsed.expiresAt,
    };
  }

  /**
   * `httpOnly` because anything script can read, an injected script can send away. `sameSite:
   * lax` because these are plain form posts with no CSRF token, so it is what stops another
   * site submitting one on a signed-in operator's behalf.
   */
  cookieOptions(environment: string): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: environment === 'prod', path: '/' };
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
