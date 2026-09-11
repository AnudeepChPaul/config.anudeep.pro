import { SyncScheduler } from '@config/src/store/sync-scheduler.js';
import { describe, expect, it, vi } from 'vitest';

describe('SyncScheduler', () => {
  it('does not idle-sync when auto-sync is off', async () => {
    vi.useFakeTimers();
    const syncNow = vi.fn(async () => ({ kind: 'clean' as const, files: [] }));
    const scheduler = new SyncScheduler({ syncNow }, 60_000, 100);
    scheduler.notifyWrite();
    await vi.advanceTimersByTimeAsync(200);
    expect(syncNow).not.toHaveBeenCalled();
    scheduler.stop();
    vi.useRealTimers();
  });

  it('debounces idle sync after writes when auto-sync is on', async () => {
    vi.useFakeTimers();
    const syncNow = vi.fn(async () => ({ kind: 'clean' as const, files: [] }));
    const scheduler = new SyncScheduler({ syncNow }, 60_000, 100);
    scheduler.setAutoSync(true);
    scheduler.notifyWrite();
    scheduler.notifyWrite();
    await vi.advanceTimersByTimeAsync(99);
    expect(syncNow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(syncNow).toHaveBeenCalledTimes(1);
    scheduler.stop();
    vi.useRealTimers();
  });

  it('does not create duplicate timer loops', () => {
    vi.useFakeTimers();
    const syncNow = vi.fn(async () => ({ kind: 'clean' as const, files: [] }));
    const scheduler = new SyncScheduler({ syncNow }, 100, 10);
    scheduler.setAutoSync(true);
    scheduler.start();
    scheduler.start();
    scheduler.stop();
    vi.advanceTimersByTime(200);
    expect(syncNow).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips the interval while auto-sync is off', async () => {
    vi.useFakeTimers();
    const syncNow = vi.fn(async () => ({ kind: 'clean' as const, files: [] }));
    const scheduler = new SyncScheduler({ syncNow }, 100, 10);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(syncNow).not.toHaveBeenCalled();
    scheduler.setAutoSync(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(syncNow).toHaveBeenCalled();
    scheduler.stop();
    vi.useRealTimers();
  });
});
