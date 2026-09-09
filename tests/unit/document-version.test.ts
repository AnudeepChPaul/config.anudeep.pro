import { SchemaSet } from '@config/src/schema/validator.js';
import { bumpedVersion, isMetadataKey, versionOf } from '@config/src/store/metadata.js';
import { describe, expect, it } from 'vitest';

/**
 * Every namespace file carries a revision counter.
 *
 * It exists so two hosts editing the same namespace can be told apart: a document whose version
 * is behind the one on origin was written against something that has since moved. Nothing acts
 * on that yet — this is the counter, kept honest, so that when the check arrives it has
 * something to compare.
 *
 * It is metadata, not configuration: it is not in the schema, not shown as a key, and not served
 * to consuming services, exactly like the `sops` block beside it.
 */
describe('the version counter', () => {
  it('reads as 0 when a document has never carried one', () => {
    // Every file that predates this, which is all of them.
    expect(versionOf({ A: 1 })).toBe(0);
  });

  it('reads the number a document carries', () => {
    expect(versionOf({ version: 7, A: 1 })).toBe(7);
  });

  it('refuses to read a version that is not a whole positive number', () => {
    // A hand-edited "version: 3.1" or "version: v3" must not become NaN and then silently
    // overwrite a real counter with garbage.
    for (const bad of ['v3', 3.5, -1, null, {}]) expect(versionOf({ version: bad })).toBe(0);
  });

  it('increments, and starts a document that had none at 1', () => {
    expect(bumpedVersion({ A: 1 })).toBe(1);
    expect(bumpedVersion({ version: 7 })).toBe(8);
  });

  it('names the keys that are metadata rather than configuration', () => {
    expect(isMetadataKey('version')).toBe(true);
    expect(isMetadataKey('sops')).toBe(true);
    expect(isMetadataKey('SESSION_TTL')).toBe(false);
  });
});

describe('the schema ignores it', () => {
  const schemas = SchemaSet.fromFiles({
    iam: 'version: 1\nkeys:\n  SESSION_TTL:\n    type: int\n',
  });

  it('accepts a document carrying a version, which is in no schema', () => {
    // Otherwise every save fails with "'version' is not a key in the iam schema" — and the
    // first thing anyone would do is delete the counter.
    expect(schemas.validate('iam', { version: 4, SESSION_TTL: 900 }).ok).toBe(true);
  });

  it('still rejects a key that is genuinely not in the schema', () => {
    expect(schemas.validate('iam', { SESSION_TTLL: 900 }).ok).toBe(false);
  });
});
