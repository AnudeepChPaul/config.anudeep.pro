import { buildSchema, type KeyDraft } from '@config/src/schema/builder.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { describe, expect, it } from 'vitest';

/**
 * Turning a form into a schema.
 *
 * A schema decides what every future value of a key is allowed to be, so a schema that is wrong
 * is worse than no schema: it accepts something the service cannot use, at the moment somebody is
 * changing config to end an outage. Everything here is enforced on the server whatever the form
 * happens to send, because a form is a convenience and a POST body is user input.
 *
 * The builder is pure — input in, YAML or errors out — so every rule can be tested without a
 * browser, a repository or a session, and the output is fed back through SchemaSet.fromFiles to
 * prove the two agree.
 */
const key = (over: Partial<KeyDraft> = {}): KeyDraft => ({
  name: 'MFA_ENFORCEMENT',
  type: 'string',
  secret: false,
  values: [],
  description: '',
  default: null,
  ...over,
});

const built = (keys: KeyDraft[]) => buildSchema({ service: 'iam', keys });
const errorsOf = (keys: KeyDraft[]) => {
  const result = built(keys);
  return result.ok ? [] : result.error.map((problem) => problem.message);
};

describe('what the builder refuses', () => {
  it('refuses a key name that is not a name', () => {
    expect(errorsOf([key({ name: '' })]).join(' ')).toMatch(/name/i);
    expect(errorsOf([key({ name: 'has space' })]).join(' ')).toMatch(/name/i);
    expect(errorsOf([key({ name: 'lower_case' })]).join(' ')).toMatch(/name/i);
  });

  // `version` and `sops` are not configuration; a key called either would be silently dropped
  // from every document that carried it.
  it('refuses a key name the document format reserves', () => {
    expect(errorsOf([key({ name: 'version' })]).join(' ')).toMatch(/reserved/i);
    expect(errorsOf([key({ name: 'sops' })]).join(' ')).toMatch(/reserved/i);
  });

  it('refuses the same key twice, whatever the form allowed', () => {
    expect(errorsOf([key(), key()]).join(' ')).toMatch(/twice|duplicate|already/i);
  });

  it('refuses a type it does not know', () => {
    expect(errorsOf([key({ type: 'timestamp' as KeyDraft['type'] })]).join(' ')).toMatch(/type/i);
  });

  // A secret is a string with `secret: true`; anything else is a form that got ahead of itself.
  it('refuses a secret that is not a string', () => {
    expect(errorsOf([key({ type: 'int', secret: true })]).join(' ')).toMatch(/secret/i);
  });

  it('refuses a default on a secret, which is the one value that must never be written here', () => {
    expect(errorsOf([key({ secret: true, default: 'hunter2' })]).join(' ')).toMatch(/secret/i);
  });

  it('refuses values on a type that cannot have them', () => {
    expect(errorsOf([key({ type: 'bool', values: ['a', 'b'] })]).join(' ')).toMatch(/values/i);
  });

  it('refuses bounds on a type that cannot have them', () => {
    expect(errorsOf([key({ type: 'string', min: 1, max: 10 })]).join(' ')).toMatch(/min|max|int/i);
  });

  it('refuses a minimum above its maximum, which no value could satisfy', () => {
    expect(errorsOf([key({ type: 'int', min: 10, max: 1 })]).join(' ')).toMatch(/min|max/i);
  });

  it('refuses a default outside the bounds it declares', () => {
    expect(errorsOf([key({ type: 'int', min: 1, max: 10, default: 50 })]).join(' ')).toMatch(
      /default/i,
    );
  });

  it('refuses a default that is not one of the declared values', () => {
    expect(errorsOf([key({ values: ['optional', 'all'], default: 'everyone' })]).join(' ')).toMatch(
      /default/i,
    );
  });

  it('refuses a default of the wrong type', () => {
    expect(errorsOf([key({ type: 'int', default: 'soon' })]).join(' ')).toMatch(/default/i);
    expect(errorsOf([key({ type: 'bool', default: 'true' })]).join(' ')).toMatch(/default/i);
  });

  it('names the key each problem belongs to, so a form can mark the right row', () => {
    const result = built([key({ name: 'A', type: 'int', min: 10, max: 1 })]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error[0]?.key).toBe('A');
  });

  it('reports every problem at once rather than one per attempt', () => {
    const problems = errorsOf([
      key({ name: 'A', type: 'int', min: 10, max: 1 }),
      key({ name: 'B', type: 'bool', values: ['x'] }),
    ]);
    expect(problems.length).toBeGreaterThan(1);
  });
});

describe('what the builder accepts', () => {
  it('accepts a schema with no keys at all', () => {
    expect(built([]).ok).toBe(true);
  });

  it('accepts a null default, which is how a key is declared without a value', () => {
    expect(built([key({ default: null })]).ok).toBe(true);
  });

  it('makes a key with declared values an enum, since that is what the validator calls it', () => {
    const result = built([key({ values: ['optional', 'all'], default: 'all' })]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatch(/type: enum/);
  });
});

describe('what the builder writes', () => {
  const yaml = (keys: KeyDraft[]) => {
    const result = built(keys);
    if (!result.ok) throw new Error(result.error.map((problem) => problem.message).join('; '));
    return result.value;
  };

  it('declares the version the readers now require', () => {
    expect(yaml([key()])).toMatch(/^version: 1/m);
  });

  it('writes a secret as a string that is marked secret, and with no value', () => {
    const written = yaml([key({ name: 'SMTP_PASSWORD', secret: true })]);
    expect(written).toMatch(/type: string/);
    expect(written).toMatch(/secret: true/);
    expect(written).not.toMatch(/default:/);
  });

  it('keeps the description, which is where a key is explained', () => {
    expect(yaml([key({ description: 'Hot-toggle registration' })])).toMatch(
      /Hot-toggle registration/,
    );
  });

  // The two must agree: the builder's output is read back by the thing that validates every
  // save, and a schema it will not accept is a product nobody can edit.
  it('produces something the validator itself accepts', () => {
    const written = yaml([
      key({ name: 'MFA_ENFORCEMENT', values: ['optional', 'all'], default: 'all' }),
      key({ name: 'SESSION_TTL', type: 'int', min: 60, max: 86400, default: 3600 }),
      key({ name: 'SMTP_PASSWORD', secret: true }),
    ]);

    const schemas = SchemaSet.fromFiles({ iam: written });
    expect(schemas.definitionsFor('iam').size).toBe(3);
    expect(schemas.isSecret('iam', 'SMTP_PASSWORD')).toBe(true);
    expect(schemas.defaultsFor('iam')).toEqual({ MFA_ENFORCEMENT: 'all', SESSION_TTL: 3600 });
  });
});
