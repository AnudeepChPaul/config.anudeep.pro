import { createHash } from 'node:crypto';

/**
 * Builds the commit message, which *is* the audit trail.
 *
 * `git log` is what replaces an events table here, so anything not in the message is recorded
 * nowhere. The rule that shapes the format: trailers carry value **hashes**, never values. That
 * is what lets one message format cover a feature flag and an SMTP password alike — the
 * alternative would write every rotated secret into a repository that is pushed to GitHub and
 * cloned onto laptops.
 */

export interface Actor {
  readonly email: string;
  readonly id: string;
}

export interface RequestContext {
  readonly id: string;
  readonly sourceIp: string;
}

export interface KeyChange {
  readonly key: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

export interface ChangeSet {
  /** The operator's own words. Becomes the subject line. */
  readonly message: string;
  readonly service: string;
  readonly environment: string;
  readonly keys: readonly KeyChange[];
}

/** Absent, rather than a hash of nothing — a key that did not exist has no previous value. */
const ABSENT = 'none';

/**
 * JSON before hashing so one rule covers strings, numbers, booleans and lists. Hashing a raw
 * string and a JSON string differently would make `"1"` and `1` indistinguishable in the log.
 */
function hashValue(value: unknown): string {
  if (value === undefined) return ABSENT;
  const canonical = typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class CommitTrailerBuilder {
  build(actor: Actor, change: ChangeSet, request: RequestContext): string {
    const trailers = [
      `Actor: ${actor.email}`,
      `Actor-Id: ${actor.id}`,
      `Service: ${change.service}`,
      `Environment: ${change.environment}`,
    ];

    for (const { key, oldValue, newValue } of change.keys) {
      trailers.push(
        `Key: ${key}`,
        `Old-Value-Hash: ${hashValue(oldValue)}`,
        `New-Value-Hash: ${hashValue(newValue)}`,
      );
    }

    trailers.push(`Request-Id: ${request.id}`, `Source-IP: ${request.sourceIp}`);

    // git parses trailers from the final paragraph, so the subject's own blank lines must not
    // be able to split the block. The subject is normalised to a single line and any further
    // prose stays between it and the trailers.
    const [subject = '', ...rest] = change.message.split('\n');
    const body = rest.join('\n').trim();

    return [subject, '', ...(body ? [body, ''] : []), trailers.join('\n')].join('\n');
  }
}
