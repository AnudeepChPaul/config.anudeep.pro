import { configureLogging, logged } from '@config/src/logging.js';
import { describe, expect, it } from 'vitest';

describe('logged', () => {
  it('records a returned validation failure as .failed, not .ok', async () => {
    const lines: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
    const log = {
      debug(fields: object, event: string) {
        lines.push({ level: 'debug', event, fields: fields as Record<string, unknown> });
      },
      warn(fields: object, event: string) {
        lines.push({ level: 'warn', event, fields: fields as Record<string, unknown> });
      },
      error(fields: object, event: string) {
        lines.push({ level: 'error', event, fields: fields as Record<string, unknown> });
      },
    };
    configureLogging('silent', true);

    const result = await logged(
      log,
      'config.write',
      { logger: 'store.product-write' },
      async () => ({
        ok: false as const,
        error: {
          code: 'invalid',
          detail: 'configuration is invalid',
          errors: [{ key: 'COUNT', message: "'COUNT' must be at least 1" }],
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(
      lines.map((line) => `${line.level}:${(line.fields as { event?: string }).event}`),
    ).toEqual(['debug:config.write.start', 'warn:config.write.failed']);
    expect(lines[0]?.event).toMatch(/Write started/);
    expect(lines[1]?.event).toMatch(/Write failed/);
    expect(lines[1]?.fields).toMatchObject({
      code: 'invalid',
      detail: 'configuration is invalid',
      error_keys: 'COUNT',
      error_messages: "'COUNT' must be at least 1",
    });
  });

  it('records kind: invalid the same way', async () => {
    const warns: string[] = [];
    await logged(
      {
        debug() {},
        warn(_fields: object, event: string) {
          warns.push((_fields as { event?: string }).event ?? event);
        },
        error() {},
      },
      'config.flag.set',
      { logger: 'flags.write' },
      async () => ({
        kind: 'invalid' as const,
        errors: [{ key: 'name', message: 'invalid flag' }],
      }),
    );
    expect(warns).toEqual(['config.flag.set.failed']);
  });
});
