import { presentWriteFailure } from '@config/src/views/field-errors.js';
import { renderProduct } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

describe('presentWriteFailure', () => {
  it('keeps the short detail when there are no field errors', () => {
    const presented = presentWriteFailure({ detail: 'configuration is invalid' });

    expect(presented.notice).toEqual({ tone: 'problem', text: 'configuration is invalid' });
    expect(presented.byKey).toEqual({});
  });

  it('puts each schema message on its key and lists them in the notice', () => {
    const presented = presentWriteFailure({
      detail: 'configuration is invalid',
      errors: [
        { key: 'SESSION_TTL', message: "'SESSION_TTL' must be at least 60" },
        {
          key: 'MFA_ENFORCEMENT',
          message: "'MFA_ENFORCEMENT' must be one of: optional, admins, all",
        },
      ],
    });

    expect(presented.notice.tone).toBe('problem');
    expect(presented.notice.text).toContain('configuration is invalid');
    expect(presented.notice.text).toContain("'SESSION_TTL' must be at least 60");
    expect(presented.notice.text).toContain(
      "'MFA_ENFORCEMENT' must be one of: optional, admins, all",
    );
    expect(presented.byKey).toEqual({
      SESSION_TTL: "'SESSION_TTL' must be at least 60",
      MFA_ENFORCEMENT: "'MFA_ENFORCEMENT' must be one of: optional, admins, all",
    });
  });

  it('joins several messages for the same key', () => {
    const presented = presentWriteFailure({
      detail: 'Invalid schema',
      errors: [
        { key: 'A', message: 'first' },
        { key: 'A', message: 'second' },
      ],
    });

    expect(presented.byKey.A).toBe('first; second');
  });
});

describe('a product page with field errors', () => {
  it('renders each key reason next to the field, not only the short detail', () => {
    const html = String(
      renderProduct({
        service: 'iam',
        environment: 'prod',
        environments: ['dev', 'prod'],
        etag: 'e',
        rows: [
          {
            key: 'SESSION_TTL',
            definition: { type: 'int', secret: false, min: 60, max: 86400 },
            value: 1,
            error: "'SESSION_TTL' must be at least 60",
          },
        ],
        version: 1,
        next: null,
        retiring: false,
        missing: false,
        notice: {
          tone: 'problem',
          text: "configuration is invalid: 'SESSION_TTL' must be at least 60",
        },
      }),
    );

    expect(html).toContain('class="err"');
    expect(html).toContain('must be at least 60');
    expect(html).toContain('configuration is invalid');
  });
});
