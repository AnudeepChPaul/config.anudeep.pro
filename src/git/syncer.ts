import type { GitRepository } from './repository.js';

/**
 * Keeps the local clone and GitHub in step.
 *
 * For now: retrying commits that could not be pushed. This is the half of the plan's failure
 * behaviour that makes committing-before-pushing honest — a save is durable and already being
 * served the moment it is committed, and publishing catches up on its own.
 *
 * It works unattended precisely because the deploy key needs no logged-in user. That was the
 * deciding argument for a deploy key over user OAuth.
 */

export interface RetryResult {
  readonly pushed: boolean;
  readonly commits: number;
}

export class GitSyncer {
  constructor(private readonly repository: GitRepository) {}

  /**
   * Pushes anything pending. Never throws.
   *
   * This runs on a timer, so an exception here would mean an unhandled rejection every interval
   * for the length of a GitHub outage — turning one failure into a flood.
   */
  async retryUnpushed(): Promise<RetryResult> {
    const pending = await this.repository.unpushedCommits().catch(() => []);
    if (pending.length === 0) return { pushed: false, commits: 0 };

    const result = await this.repository.push();
    return { pushed: result.pushed, commits: result.pushed ? pending.length : 0 };
  }
}
