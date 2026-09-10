import { composeGlobalSchema } from '@config/src/cli/migrate-schema.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { describe, expect, it } from 'vitest';

describe('global schema document', () => {
  it('loads definitions and retirement state for every product', () => {
    const schemas = SchemaSet.fromDocument(`
version: 1
services:
  web:
    retiring: true
    keys:
      CHECKOUT_URL: { type: url }
`);

    expect(schemas.has('web')).toBe(true);
    expect(schemas.isRetiring('web')).toBe(true);
    expect(schemas.definitionsFor('web').get('CHECKOUT_URL')?.type).toBe('url');
  });

  it('composes legacy files into a globally valid document', () => {
    const source = composeGlobalSchema({
      web: 'version: 1\nretiring: false\nkeys:\n  ENABLED: { type: bool }\n',
    });
    const schemas = SchemaSet.fromDocument(source);
    expect(schemas.validate('web', { ENABLED: true }).ok).toBe(true);
  });
});
