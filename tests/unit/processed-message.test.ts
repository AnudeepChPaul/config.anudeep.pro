import { processedMessage } from '@config/src/logging/message.js';
import { describe, expect, it } from 'vitest';

describe('processedMessage', () => {
  it('turns debug events into a sentence with duration', () => {
    expect(processedMessage('config.db.snapshot.start', { logger: 'store.db' })).toBe(
      'Database snapshot started',
    );
    expect(processedMessage('config.db.snapshot.ok', { duration_ms: 12.4355 })).toBe(
      'Database snapshot completed (12.4ms)',
    );
  });

  it('includes validation detail on a failed write', () => {
    expect(
      processedMessage('config.write.failed', {
        code: 'invalid',
        detail: 'configuration is invalid',
        error_messages: "'COUNT' must be at least 1",
      }),
    ).toBe("Write failed: invalid · configuration is invalid · 'COUNT' must be at least 1");
  });
});
