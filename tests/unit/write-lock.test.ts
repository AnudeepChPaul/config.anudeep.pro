import { WriteLock } from '@config/src/git/write-lock.js';
import { describe, expect, it } from 'vitest';

/**
 * Git has no concurrency control, so this is it.
 *
 * Two saves running at once would interleave `git add` and `git commit` against one working
 * tree, and the second commit would silently carry the first's staged changes. The stale-commit
 * check cannot catch that: both writers read the same HEAD before either wrote.
 */

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe('WriteLock', () => {
  it('returns what the critical section returned', async () => {
    expect(await new WriteLock().withLock(async () => 'committed')).toBe('committed');
  });

  it('runs one critical section at a time', async () => {
    const lock = new WriteLock();
    const first = deferred();
    const order: string[] = [];

    const a = lock.withLock(async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = lock.withLock(async () => {
      order.push('b:start');
    });

    // b must not have started while a holds the lock, however long a takes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['a:start']);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('releases the lock when the critical section throws', async () => {
    // A failed commit must not wedge every future write. This is the deadlock that turns one
    // bad save into an outage of the whole write path.
    const lock = new WriteLock();

    await expect(
      lock.withLock(async () => {
        throw new Error('commit failed');
      }),
    ).rejects.toThrow('commit failed');

    expect(await lock.withLock(async () => 'still works')).toBe('still works');
  });

  it('propagates the original error rather than wrapping it', async () => {
    const lock = new WriteLock();
    const boom = new Error('sops exited 1');

    await expect(lock.withLock(async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('runs waiters in the order they arrived', async () => {
    // Two operators saving during an incident should land in the order they pressed save, so
    // the git history matches what they saw.
    const lock = new WriteLock();
    const gate = deferred();
    const order: number[] = [];

    const first = lock.withLock(async () => {
      await gate.promise;
      order.push(0);
    });
    const rest = [1, 2, 3].map((n) => lock.withLock(async () => void order.push(n)));

    gate.release();
    await Promise.all([first, ...rest]);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('reports whether it is currently held', async () => {
    // The UI shows "a save is in progress" rather than appearing to hang.
    const lock = new WriteLock();
    const gate = deferred();

    expect(lock.held()).toBe(false);
    const running = lock.withLock(async () => {
      expect(lock.held()).toBe(true);
      await gate.promise;
    });

    gate.release();
    await running;
    expect(lock.held()).toBe(false);
  });
});
