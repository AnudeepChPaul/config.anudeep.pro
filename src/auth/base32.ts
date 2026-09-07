/**
 * RFC 4648 base32, which is how every authenticator app exchanges a TOTP secret.
 *
 * Decoding only: the secret is generated as bytes and shown once as base32, never read back.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Buffer {
  // Padding and casing vary between the apps that print these; the payload does not.
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}
