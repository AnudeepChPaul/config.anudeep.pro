import type { UnpushedCommit } from '@config/src/git/repository.js';
import { PendingSync } from '@config/src/store/pending-sync.js';
import type { JournalEntry } from '@config/src/store/write-journal.js';
import { describe, expect, it } from 'vitest';

const entry: JournalEntry = {
  actor: 'operator@example.com',
  path: 'config/iam/prod.yaml',
  keys: ['SESSION_TTL'],
  revision: '1',
  timestamp: '2026-09-11T00:00:00.000Z',
};

const commit = (subject: string): UnpushedCommit => ({ sha: 'abc', subject });

describe('PendingSync', () => {
  it('is not ready without a remote', async () => {
    const pending = new PendingSync(
      { peek: async () => [entry] },
      { unpushedCommits: async () => [commit('x')] },
      false,
    );
    const report = await pending.report();
    expect(report.ready).toBe(false);
    expect(report.unpushed).toEqual([]);
  });

  it('is ready when a remote exists and the journal has entries', async () => {
    const pending = new PendingSync(
      { peek: async () => [entry] },
      { unpushedCommits: async () => [] },
      true,
    );
    expect((await pending.report()).ready).toBe(true);
  });

  it('is ready when a remote exists and commits are unpushed', async () => {
    const pending = new PendingSync(
      { peek: async () => [] },
      { unpushedCommits: async () => [commit('sync iam')] },
      true,
    );
    const report = await pending.report();
    expect(report.ready).toBe(true);
    expect(report.unpushed.map((item) => item.subject)).toEqual(['sync iam']);
  });

  it('is not ready when the journal and unpushed list are empty', async () => {
    const pending = new PendingSync(
      { peek: async () => [] },
      { unpushedCommits: async () => [] },
      true,
    );
    expect((await pending.report()).ready).toBe(false);
  });
});
