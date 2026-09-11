import type { SyncResult } from '@config/src/store/sync-engine.js';
import { type Notice, noticeFor } from '@config/src/views/notices.js';

export type BackupNoticeCode = 'backup-failed' | 'backup-deferred' | 'backup-no-remote';

/** Last git-backup outcome visible in the console. Process memory only. */
export class SyncStatus {
  private code: BackupNoticeCode | null = null;

  notice(): Notice | null {
    return this.code ? noticeFor(this.code) : null;
  }

  clear(): void {
    this.code = null;
  }

  noteError(): void {
    this.code = 'backup-failed';
  }

  noteResult(result: SyncResult): void {
    if (result.kind === 'synced') {
      this.code = null;
      return;
    }
    if (result.kind === 'clean') return;
    this.code = result.reason?.includes('no remote') ? 'backup-no-remote' : 'backup-deferred';
  }
}
