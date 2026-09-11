import { logCaught } from '@config/src/logging.js';

/**
 * Serialises writes to the repository.
 *
 * Git has no concurrency control, so this is it. Two saves running at once would interleave
 * `git add` and `git commit` against one working tree, and the second commit would silently
 * carry the first's staged changes. The stale-commit check cannot catch that — both writers
 * read the same HEAD before either of them wrote.
 *
 * In-process only, which is sufficient because one process owns the clone. A second writer
 * would need a lock in the filesystem; today the socket-liveness check keeps a second instance
 * from starting at all.
 */
export class WriteLock {
  /** The tail of the queue. Awaiting it means waiting for everyone already in line. */
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** Whether a critical section is running, so the UI can say so rather than appear to hang. */
  held(): boolean {
    return this.depth > 0;
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chaining onto the tail is what makes waiters run in arrival order: each caller waits for
    // the previous one, not for a shared signal that would wake them in an arbitrary order.
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch((error: unknown) => {
      logCaught(error, 'config.write-lock.previous.failed', { logger: 'git.write-lock' });
    });
    this.depth += 1;

    try {
      return await fn();
    } finally {
      // Always, even when fn threw. A failed commit that kept the lock would turn one bad save
      // into an outage of the entire write path.
      this.depth -= 1;
      release();
    }
  }
}
