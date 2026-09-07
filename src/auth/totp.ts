import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 time-based one-time passwords.
 *
 * Implemented here because the whole of it is an HMAC and a counter, and a dependency for that
 * is a dependency to keep patched. It is checked against the RFC's published vectors rather
 * than against its own output — an implementation that agrees only with itself passes every
 * test and rejects every code from the operator's phone.
 */

/** The step every authenticator app assumes. */
const STEP_SECONDS = 30;

/** How many steps back to accept. One covers a slow typist and a slightly slow clock. */
const TOLERANCE = 1;

export interface TotpOptions {
  readonly counter: number;
  readonly digits?: number;
}

export const totpCounter = (unixSeconds: number): number => Math.floor(unixSeconds / STEP_SECONDS);

export function generateTotp(secret: Buffer, options: TotpOptions): string {
  const digits = options.digits ?? 6;

  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(options.counter));
  const digest = createHmac('sha1', secret).update(message).digest();

  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks the offset.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  // Padded, because a code is a fixed-width string and not a number: dropping a leading zero
  // would make one code in ten fail, intermittently, forever.
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface VerifyOptions {
  readonly secret: Buffer;
  readonly now: number;
  readonly digits?: number;
  /** The highest counter already spent. Codes at or below it are refused. */
  readonly lastUsedCounter?: number;
}

export type TotpResult = { ok: true; counter: number } | { ok: false };

export function verifyTotp(code: string, options: VerifyOptions): TotpResult {
  const digits = options.digits ?? 6;
  if (code.length !== digits) return { ok: false };

  const current = totpCounter(options.now);

  for (let back = 0; back <= TOLERANCE; back += 1) {
    const counter = current - back;

    // A code is valid for its whole step, so without this anyone who saw it — over a shoulder,
    // in a screen share, in a proxy log — could reuse it until the step ended. Break-glass is
    // the login where that matters most.
    if (options.lastUsedCounter !== undefined && counter <= options.lastUsedCounter) continue;

    const expected = generateTotp(options.secret, { counter, digits });
    if (equals(code, expected)) return { ok: true, counter };
  }

  return { ok: false };
}

/** Constant time in the length-equal case, so a wrong code leaks nothing about the right one. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
