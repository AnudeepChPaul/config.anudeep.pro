import { randomBytes } from 'node:crypto';
import { encodeBase32 } from '../auth/base32.js';
import { type BreakGlassRecord, hashPassword } from '../auth/break-glass.js';

/**
 * Mints the break-glass credential.
 *
 * A CLI rather than a page in the editor, because the editor is precisely what this credential
 * exists to reach when nothing else works. Bootstrapping it through the door it unlocks is
 * circular, and would mean the credential could be replaced by whoever already has access.
 *
 * The output goes into the config repository as a SOPS-encrypted file. The plaintext password
 * is printed once, here, and never stored.
 */

/** 160 bits, as RFC 4226 recommends for a TOTP secret. */
const TOTP_SECRET_BYTES = 20;

/** Long enough that the scrypt cost is not what is protecting it. */
const PASSWORD_BYTES = 24;

export interface BootstrapResult {
  readonly record: BreakGlassRecord;
  /** Printed once and never stored. The record holds only its hash. */
  readonly password: string;
  readonly otpauthUri: string;
}

export async function buildBreakGlassRecord(actorEmail: string): Promise<BootstrapResult> {
  // Generated, not chosen. A human-picked password for the one credential that bypasses the
  // identity provider is the weakest link on the platform, and it is typed once a year at most.
  const password = randomBytes(PASSWORD_BYTES).toString('base64url');
  const totpSecret = encodeBase32(randomBytes(TOTP_SECRET_BYTES));

  const otpauth = new URL(`otpauth://totp/config.anudeep.pro:${encodeURIComponent(actorEmail)}`);
  otpauth.searchParams.set('secret', totpSecret);
  otpauth.searchParams.set('issuer', 'config.anudeep.pro');
  otpauth.searchParams.set('algorithm', 'SHA1');
  otpauth.searchParams.set('digits', '6');
  otpauth.searchParams.set('period', '30');

  return {
    record: { passwordHash: await hashPassword(password), totpSecret, actorEmail },
    password,
    otpauthUri: otpauth.toString(),
  };
}

async function main(): Promise<void> {
  const actorEmail = process.argv[2];
  if (!actorEmail) {
    process.stderr.write('usage: bootstrap-breakglass <actor-email>\n');
    process.exit(2);
  }

  const { record, password, otpauthUri } = await buildBreakGlassRecord(actorEmail);

  // The record goes to stdout so it can be piped into sops; everything a human must read or
  // copy goes to stderr, so `> break-glass.yaml` captures the file and nothing else.
  process.stderr.write('\nBreak-glass credential created.\n\n');
  process.stderr.write(`  Password: ${password}\n`);
  process.stderr.write(`  TOTP:     ${otpauthUri}\n\n`);
  process.stderr.write(
    'Store the password in a password manager now — it is not written anywhere.\n',
  );
  process.stderr.write('Scan the TOTP URI into an authenticator, then encrypt the record:\n\n');
  process.stderr.write(
    '  ... | sops --encrypt --input-type yaml --output-type yaml /dev/stdin > break-glass.yaml\n\n',
  );

  process.stdout.write(
    `passwordHash: ${JSON.stringify(record.passwordHash)}\n` +
      `totpSecret: ${JSON.stringify(record.totpSecret)}\n` +
      `actorEmail: ${JSON.stringify(record.actorEmail)}\n`,
  );
}

// Only when run directly, so importing this for tests does not mint a credential.
if (
  process.argv[1]?.endsWith('bootstrap-breakglass.ts') ||
  process.argv[1]?.endsWith('bootstrap-breakglass.js')
) {
  void main();
}
