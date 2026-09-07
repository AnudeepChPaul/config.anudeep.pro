import { redactAgeKey } from '@config/src/store/sops.js';
import { describe, expect, it } from 'vitest';

/**
 * Redaction, tested directly.
 *
 * The end-to-end version of this assertion was vacuous: sops does not echo the age key, so the
 * error text was clean whether or not anything redacted it, and deleting the redaction left the
 * suite green. Asserting the function itself is the only way to hold the behaviour.
 */

const KEY = 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQZZZZZZ';

describe('redactAgeKey', () => {
  it('removes the key from text that is about to become an error message', () => {
    expect(redactAgeKey(`failed with ${KEY}`, KEY)).toBe('failed with [redacted age key]');
  });

  it('removes every occurrence, not only the first', () => {
    expect(redactAgeKey(`${KEY} and again ${KEY}`, KEY)).not.toContain(KEY);
  });

  it('leaves text that does not contain the key alone', () => {
    expect(redactAgeKey('no keys here', KEY)).toBe('no keys here');
  });

  it('is a no-op when no key is configured, rather than redacting everything', () => {
    // An empty needle would otherwise match at every position and destroy the message.
    expect(redactAgeKey('sops exited 128', '')).toBe('sops exited 128');
  });
});
