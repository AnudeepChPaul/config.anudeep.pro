import { FlagSet, FlagValidator } from '@config/src/flags/flag-document.js';
import { describe, expect, it } from 'vitest';

const environments = { has: (name: string) => ['dev', 'staging', 'prod'].includes(name) };
const validator = new FlagValidator(environments);

describe('FlagValidator', () => {
  it('parses valid flags and resolves absent environments to false', () => {
    const result = validator.validateFile(`
version: 1
flags:
  NewCheckout:
    dev: true
    prod: false
  Checkout2:
    prod: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flags = new FlagSet(result.value);
    expect(flags.valueOf('NewCheckout', 'dev')).toBe(true);
    expect(flags.valueOf('NewCheckout', 'staging')).toBe(false);
    expect(flags.resolveFor('prod')).toEqual({ NewCheckout: false, Checkout2: true });
  });

  it('reports malformed names, values, and environments together', () => {
    const result = validator.validateFile(`
version: 1
flags:
  bad-name:
    dev: yes
    qa: true
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual([
      { key: 'bad-name', message: 'flag name must be TitleCase' },
      { key: 'bad-name.dev', message: 'flag value must be true or false' },
      { key: 'bad-name.qa', message: "unknown environment 'qa'" },
    ]);
  });

  it('refuses snake_case, camelCase, and names that start with a digit', () => {
    const result = validator.validateFile(`
version: 1
flags:
  NEW_CHECKOUT:
    dev: true
  newCheckout:
    dev: true
  2Checkout:
    dev: true
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual([
      { key: 'NEW_CHECKOUT', message: 'flag name must be TitleCase' },
      { key: 'newCheckout', message: 'flag name must be TitleCase' },
      { key: '2Checkout', message: 'flag name must be TitleCase' },
    ]);
  });

  it('rejects malformed YAML and wrong document metadata', () => {
    expect(validator.validateFile('version: 2\nflags: {}').ok).toBe(false);
    expect(validator.validateFile('flags: [true]').ok).toBe(false);
    expect(validator.validateFile('version: [').ok).toBe(false);
  });
});
