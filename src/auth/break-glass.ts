import {
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { err, ok, type Result } from '../identity/types.js';
import { logged } from '../logging.js';
import { decodeBase32 } from './base32.js';
import { totpCounter, verifyTotp } from './totp.js';

/**
 * The credential that works when iam does not.
 *
 * Two things set it apart from an ordinary login. It is reachable *only* while the identity
 * provider is unreachable, so its very availability is a signal rather than a convenience. And
 * it is the one credential that cannot be revoked through the system it protects — which is why
 * every use alerts, whether it succeeded, failed, or was refused for being unnecessary.
 *
 * The record lives in the config repository, SOPS-encrypted. That is not circular: the service
 * reads its own repository directly, not through its own socket API, so it can still read this
 * during an iam outage.
 */

/**
 * `promisify` resolves to scrypt's three-argument overload and drops the options one, so the
 * cost parameters would not typecheck. Wrapped by hand to keep them.
 */
const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });

/**
 * Deliberately slow. The cost is the point: it is paid once, by a human, during an incident.
 *
 * `maxmem` has to be set explicitly — 128 * N * r is exactly 32MB here, which is Node's default
 * ceiling, so the default rejects these parameters rather than the parameters being wrong.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

export interface BreakGlassRecord {
  readonly passwordHash: string;
  /** Base32, as an authenticator app expects. */
  readonly totpSecret: string;
  readonly actorEmail: string;
}

export interface BreakGlassAlert {
  readonly outcome: 'succeeded' | 'failed' | 'refused_iam_up';
  readonly at: number;
}

export interface BreakGlassActor {
  readonly email: string;
  readonly id: string;
}

export interface Denied {
  readonly code: 'break_glass_denied';
  readonly detail: string;
}

/**
 * One shared denial for every path. A per-reason message would turn the form into an oracle for
 * whether the password was right, leaving only the second factor.
 */
const DENIED: Denied = Object.freeze({
  code: 'break_glass_denied',
  detail: 'Break-glass sign-in is not available.',
});

export interface BreakGlassOptions {
  readonly record: BreakGlassRecord | null;
  /** Break-glass is refused whenever this returns true. */
  readonly isIamReachable: () => Promise<boolean>;
  readonly alert: (alert: BreakGlassAlert) => void;
  readonly now?: () => number;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  // The parameters travel with the hash so they can be raised later without invalidating every
  // existing credential.
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;

  const expected = Buffer.from(hash, 'base64');
  const derived = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export class BreakGlass {
  /**
   * The highest TOTP counter already spent, in memory only.
   *
   * Deliberately not persisted to git: a commit per login attempt would make the audit trail
   * mostly noise, and a restart only reopens a window of at most one 30-second step.
   */
  private lastUsedCounter: number | undefined;

  constructor(private readonly options: BreakGlassOptions) {}

  async attempt(password: string, code: string): Promise<Result<BreakGlassActor, Denied>> {
    return logged(
      undefined,
      'config.break-glass.attempt',
      { logger: 'auth.break-glass' },
      async () => {
        const now = (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
        const { record } = this.options;

        if (await this.options.isIamReachable()) {
          // Refused before the credentials are even examined, so this path cannot be used to test
          // passwords while iam is healthy — and the code is not spent, because the operator will
          // need it when iam actually goes down.
          this.options.alert({ outcome: 'refused_iam_up', at: now });
          return err(DENIED);
        }

        if (!record) {
          // A repository with no break-glass record must not be one that anyone can edit during an
          // outage. The wasted work keeps an unconfigured instance from answering instantly, which
          // would tell an attacker to go and try another door.
          await hashPassword(password);
          this.options.alert({ outcome: 'failed', at: now });
          return err(DENIED);
        }

        const passwordOk = await verifyPassword(password, record.passwordHash);
        const totp = verifyTotp(code, {
          secret: decodeBase32(record.totpSecret),
          now,
          lastUsedCounter: this.lastUsedCounter,
        });

        // Both are evaluated before either is judged, so the response time does not say which one
        // failed.
        if (!passwordOk || !totp.ok) {
          this.options.alert({ outcome: 'failed', at: now });
          return err(DENIED);
        }

        this.lastUsedCounter = totp.counter;
        this.options.alert({ outcome: 'succeeded', at: now });

        return ok({ email: record.actorEmail, id: `break-glass:${totpCounter(now)}` });
      },
    );
  }
}
