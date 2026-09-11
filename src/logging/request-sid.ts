/**
 * The request session identifier: minted here, trusted from nobody.
 *
 * This value is the forensic key — it is how one incident is reconstructed from a log store —
 * and it is reflected on the response. Taking it from the caller would let them collide with a
 * legitimate request's trail. Inbound `X-Request-Sid` is ignored.
 */
import { randomBytes } from 'node:crypto';

export const HEADER_REQUEST_SID = 'X-Request-Sid';
export const REQUEST_SID_PREFIX = 'sid_';

let lastMs = 0;
let counter = 0;

/** RFC 9562 UUIDv7 — time-ordered so ids sort chronologically as strings. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  let ms = Date.now();

  if (ms === lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      ms = lastMs + 1;
      lastMs = ms;
      counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
    }
  } else {
    if (ms < lastMs) ms = lastMs;
    lastMs = ms;
    counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }

  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mintRequestSid(): string {
  return `${REQUEST_SID_PREFIX}${uuidv7()}`;
}
