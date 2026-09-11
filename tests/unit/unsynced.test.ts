import { unsyncedKeyCounts, unsyncedTotal } from '@config/src/store/unsynced.js';
import type { JournalEntry } from '@config/src/store/write-journal.js';
import { describe, expect, it } from 'vitest';

const entry = (over: Partial<JournalEntry> & Pick<JournalEntry, 'path' | 'keys'>): JournalEntry => ({
  actor: 'ops@anudeep.pro',
  revision: '1',
  timestamp: '2026-09-11T00:00:00.000Z',
  ...over,
});

describe('unsynced key counts', () => {
  it('counts unique config keys per product and ignores metadata', () => {
    const counts = unsyncedKeyCounts([
      entry({ path: 'config/iam/dev.yaml', keys: ['SESSION_TTL', 'version'] }),
      entry({ path: 'config/iam/prod.yaml', keys: ['SESSION_TTL', 'MFA_ENFORCEMENT'] }),
      entry({ path: 'config/audit/dev.yaml', keys: ['RETENTION'] }),
      entry({ path: 'flags.yaml', keys: ['NEW_CHECKOUT'] }),
    ]);

    expect(counts.get('iam')).toBe(2);
    expect(counts.get('audit')).toBe(1);
    expect(counts.has('flags.yaml' as never)).toBe(false);
    expect(unsyncedTotal(counts)).toBe(3);
  });
});
