import { SyncStatus } from '@config/src/store/sync-status.js';
import { describe, expect, it } from 'vitest';

describe('SyncStatus', () => {
  it('has no notice until a failure', () => {
    expect(new SyncStatus().notice()).toBeNull();
  });

  it('records a thrown sync as backup-failed', () => {
    const status = new SyncStatus();
    status.noteError();
    expect(status.notice()?.tone).toBe('problem');
    expect(status.notice()?.text).toMatch(/failed/i);
  });

  it('records a deferred push without claiming live values were unchanged', () => {
    const status = new SyncStatus();
    status.noteResult({ kind: 'deferred', files: ['a'], reason: 'Permission denied' });
    expect(status.notice()?.text).toMatch(/not yet on the remote/i);
    expect(status.notice()?.text).not.toMatch(/unchanged/i);
  });

  it('clears on a successful sync', () => {
    const status = new SyncStatus();
    status.noteError();
    status.noteResult({ kind: 'synced', files: ['a'], commit: 'abc' });
    expect(status.notice()).toBeNull();
  });

  it('leaves a problem in place on a clean result', () => {
    const status = new SyncStatus();
    status.noteError();
    status.noteResult({ kind: 'clean', files: [] });
    expect(status.notice()?.tone).toBe('problem');
  });
});
