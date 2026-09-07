import { SchemaSet } from '@config/src/schema/validator.js';
import { describe, expect, it } from 'vitest';

/**
 * Typed keys, checked at write time.
 *
 * The point of this file is *when* it runs, not what it computes. Without it, a typo or a
 * wrong type is discovered at some service's next boot — which, since config is edited during
 * incidents, means the config change made to fix an outage is the thing that extends it. The
 * validator moves that discovery to the moment the operator presses save, while they are still
 * looking at the screen and a `git revert` is not yet needed.
 */

const IAM_SCHEMA = `
keys:
  MFA_ENFORCEMENT:
    type: enum
    values: [optional, admins, all]
  REGISTRATION_MODE:
    type: enum
    values: [open, invite_only, closed]
  SESSION_TTL:
    type: int
    min: 60
    max: 86400
  KILL_PASSWORD_LOGIN:
    type: bool
  FP_COMPONENTS:
    type: string[]
  WEBHOOK_URL:
    type: url
  SMTP_PASSWORD:
    type: string
    secret: true
`;

const schemas = (files: Record<string, string> = { iam: IAM_SCHEMA }) => SchemaSet.fromFiles(files);

/** The keys of the errors a rejected validation reported. */
const badKeys = (result: ReturnType<SchemaSet['validate']>) =>
  result.ok ? [] : result.error.map((e) => e.key).sort();

describe('SchemaSet.fromFiles', () => {
  it('rejects a key declaring a type it does not support', () => {
    expect(() => schemas({ iam: 'keys:\n  A:\n    type: timestamp\n' })).toThrow(/timestamp/);
  });

  it('rejects an enum with no values, which could never be satisfied', () => {
    expect(() => schemas({ iam: 'keys:\n  A:\n    type: enum\n    values: []\n' })).toThrow(/A/);
  });

  it('rejects an int whose min exceeds its max', () => {
    // No value satisfies it, so every future write to the key would fail with a message about
    // the value rather than about the schema.
    expect(() => schemas({ iam: 'keys:\n  A:\n    type: int\n    min: 10\n    max: 1\n' })).toThrow(
      /A/,
    );
  });

  it('rejects a schema file that is not a mapping of keys', () => {
    expect(() => schemas({ iam: '- a\n- b\n' })).toThrow(/iam/);
  });

  it('accepts a schema declaring no keys', () => {
    // A service that is known but overrides nothing yet.
    expect(() => schemas({ iam: 'keys: {}\n' })).not.toThrow();
  });
});

describe('SchemaSet.validate — accepting', () => {
  it('accepts a config using every supported type correctly', () => {
    const result = schemas().validate('iam', {
      MFA_ENFORCEMENT: 'all',
      SESSION_TTL: 3600,
      KILL_PASSWORD_LOGIN: true,
      FP_COMPONENTS: ['ua', 'lang'],
      WEBHOOK_URL: 'https://hooks.anudeep.pro/config',
    });

    expect(result.ok).toBe(true);
  });

  it('accepts a config that sets nothing at all', () => {
    // Principle 5: the registry is an override channel, never the origin. Every key has a
    // compiled-in default, so an absent key is the normal case and not an omission.
    expect(schemas().validate('iam', {}).ok).toBe(true);
  });

  it('does not require a key merely because the schema declares it', () => {
    expect(schemas().validate('iam', { SESSION_TTL: 300 }).ok).toBe(true);
  });

  it('accepts the boundary values of an int range', () => {
    expect(schemas().validate('iam', { SESSION_TTL: 60 }).ok).toBe(true);
    expect(schemas().validate('iam', { SESSION_TTL: 86400 }).ok).toBe(true);
  });

  it('accepts an empty list for a list-typed key', () => {
    // Emptying FP_COMPONENTS is the documented escape hatch for fingerprint false positives.
    expect(schemas().validate('iam', { FP_COMPONENTS: [] }).ok).toBe(true);
  });
});

describe('SchemaSet.validate — rejecting', () => {
  it('rejects a key the schema does not declare', () => {
    // A typo in a key name is silent otherwise: the write succeeds, the service reads its
    // default, and nothing anywhere reports that the change had no effect.
    const result = schemas().validate('iam', { MFA_ENFORCMENT: 'all' });

    expect(badKeys(result)).toEqual(['MFA_ENFORCMENT']);
  });

  it('rejects a value of the wrong type', () => {
    expect(badKeys(schemas().validate('iam', { SESSION_TTL: 'an hour' }))).toEqual(['SESSION_TTL']);
  });

  it('rejects a float for an int key', () => {
    expect(badKeys(schemas().validate('iam', { SESSION_TTL: 3.5 }))).toEqual(['SESSION_TTL']);
  });

  it('rejects an int below its minimum and above its maximum', () => {
    expect(badKeys(schemas().validate('iam', { SESSION_TTL: 59 }))).toEqual(['SESSION_TTL']);
    expect(badKeys(schemas().validate('iam', { SESSION_TTL: 86401 }))).toEqual(['SESSION_TTL']);
  });

  it('rejects a quoted string for a bool key', () => {
    // YAML would have produced a real boolean; a string here means someone wrote "true" in a
    // form field, and the consuming service would read it as truthy regardless of its contents.
    expect(badKeys(schemas().validate('iam', { KILL_PASSWORD_LOGIN: 'false' }))).toEqual([
      'KILL_PASSWORD_LOGIN',
    ]);
  });

  it('rejects an enum value that is not one of the declared values', () => {
    expect(badKeys(schemas().validate('iam', { MFA_ENFORCEMENT: 'everyone' }))).toEqual([
      'MFA_ENFORCEMENT',
    ]);
  });

  it('names the permitted values when it rejects an enum', () => {
    // The operator is mid-incident. The message has to be enough to fix it without opening the
    // schema file.
    const result = schemas().validate('iam', { MFA_ENFORCEMENT: 'everyone' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error[0]?.message).toMatch(/optional.*admins.*all/);
  });

  it('rejects a malformed url', () => {
    expect(badKeys(schemas().validate('iam', { WEBHOOK_URL: 'not a url' }))).toEqual([
      'WEBHOOK_URL',
    ]);
  });

  it('rejects a url scheme that is not http or https', () => {
    // `file:` and `gopher:` parse fine. A config key holding a webhook target must not be able
    // to point a service at the local filesystem.
    expect(badKeys(schemas().validate('iam', { WEBHOOK_URL: 'file:///etc/passwd' }))).toEqual([
      'WEBHOOK_URL',
    ]);
  });

  it('rejects a bare string for a list key', () => {
    expect(badKeys(schemas().validate('iam', { FP_COMPONENTS: 'ua' }))).toEqual(['FP_COMPONENTS']);
  });

  it('rejects a list containing a non-string', () => {
    expect(badKeys(schemas().validate('iam', { FP_COMPONENTS: ['ua', 7] }))).toEqual([
      'FP_COMPONENTS',
    ]);
  });

  it('rejects null, which is not a way to unset a key', () => {
    // Removing an override is deleting the key, not setting it to null — otherwise the tree
    // carries a value that means "no value" and every consumer has to handle it.
    expect(badKeys(schemas().validate('iam', { SESSION_TTL: null }))).toEqual(['SESSION_TTL']);
  });

  it('rejects a service with no schema file rather than letting it through unchecked', () => {
    const result = schemas().validate('audit', { ANYTHING: 1 });

    expect(result.ok).toBe(false);
  });
});

describe('SchemaSet.validate — reporting', () => {
  it('reports every problem at once, not just the first', () => {
    // A save that fails one error at a time is a save that takes five round trips during an
    // incident.
    const result = schemas().validate('iam', {
      SESSION_TTL: 'an hour',
      MFA_ENFORCEMENT: 'everyone',
      NONSENSE: true,
    });

    expect(badKeys(result)).toEqual(['MFA_ENFORCEMENT', 'NONSENSE', 'SESSION_TTL']);
  });
});

describe('SchemaSet secrets', () => {
  it('knows which keys must be encrypted before they are committed', () => {
    const set = schemas();

    expect(set.isSecret('iam', 'SMTP_PASSWORD')).toBe(true);
    expect(set.isSecret('iam', 'MFA_ENFORCEMENT')).toBe(false);
    expect(set.isSecret('iam', 'NOT_A_KEY')).toBe(false);
  });

  it('accepts a plaintext value for a secret key, since encryption happens after validation', () => {
    expect(schemas().validate('iam', { SMTP_PASSWORD: 'hunter2' }).ok).toBe(true);
  });

  it('accepts an already-encrypted value for a secret key', () => {
    // Validating the repository as committed — what CI does in slice 12 — sees ciphertext, and
    // must not demand that a password look like a password.
    const result = schemas().validate('iam', {
      SMTP_PASSWORD: 'ENC[AES256_GCM,data:x9Kd,iv:aa,tag:bb,type:str]',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects an encrypted value sitting in a key that is not marked secret', () => {
    // Either the value is a secret and the schema is wrong, or `.sops.yaml` encrypted something
    // it should not have. Both are worth stopping for; neither is safe to serve.
    expect(
      badKeys(schemas().validate('iam', { MFA_ENFORCEMENT: 'ENC[AES256_GCM,data:x9Kd,type:str]' })),
    ).toEqual(['MFA_ENFORCEMENT']);
  });
});
