import { logged } from '@config/src/logging.js';
import type { UnpushedCommit } from '@config/src/git/repository.js';
import type { JournalEntry, WriteJournal } from '@config/src/store/write-journal.js';

export interface PendingSyncReport {
  readonly entries: readonly JournalEntry[];
  readonly unpushed: readonly UnpushedCommit[];
  readonly ready: boolean;
}

/** Whether local backup work differs from the configured remote. Never rotates the journal. */
export class PendingSync {
  constructor(
    private readonly journal: Pick<WriteJournal, 'peek'>,
    private readonly git: { unpushedCommits(): Promise<UnpushedCommit[]> },
    private readonly hasRemote: boolean,
  ) {}

  async report(): Promise<PendingSyncReport> {
    return logged(undefined, 'config.pending-sync.report', { logger: 'store.pending-sync' }, async () => {
      const entries = await this.journal.peek();
      const unpushed = this.hasRemote ? await this.git.unpushedCommits() : [];
      return {
        entries,
        unpushed,
        ready: this.hasRemote && (entries.length > 0 || unpushed.length > 0),
      };
    });
  }
}
