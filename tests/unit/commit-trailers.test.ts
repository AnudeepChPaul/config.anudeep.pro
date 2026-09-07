import { createHash } from 'node:crypto';
import { CommitTrailerBuilder } from '@config/src/git/commit-trailers.js';
import { describe, expect, it } from 'vitest';

/**
 * The commit message *is* the audit trail. `git log` is what replaces an events table, so what
 * is not in the message is not recorded anywhere.
 *
 * The rule that shapes everything here: trailers carry value **hashes**, never values. That is
 * what makes one message format safe for a secret and a feature flag alike — otherwise every
 * secret rotation would write the old and new password into a repository that is pushed to
 * GitHub and cloned onto laptops.
 */

const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const ACTOR = { email: 'me@anudeep.pro', id: '7f3a1c9e' };
const REQUEST = { id: '01JQZX', sourceIp: '203.0.113.7' };

const build = (change: Parameters<CommitTrailerBuilder['build']>[1]) =>
  new CommitTrailerBuilder().build(ACTOR, change, REQUEST);

const CHANGE = {
  message: 'Set iam MFA enforcement to required-for-all',
  service: 'iam',
  environment: 'prod',
  keys: [{ key: 'MFA_ENFORCEMENT', oldValue: 'optional', newValue: 'all' }],
};

describe('CommitTrailerBuilder', () => {
  it('uses the operator audit message as the subject line', () => {
    // Someone reading `git log --oneline` during an incident sees why, not which key.
    expect(build(CHANGE).split('\n')[0]).toBe('Set iam MFA enforcement to required-for-all');
  });

  it('separates the subject from the body with a blank line', () => {
    // Otherwise git treats the whole thing as one subject and every log view is unreadable.
    expect(build(CHANGE).split('\n')[1]).toBe('');
  });

  it('records who made the change', () => {
    const message = build(CHANGE);

    expect(message).toContain('Actor: me@anudeep.pro');
    expect(message).toContain('Actor-Id: 7f3a1c9e');
  });

  it('records what was changed', () => {
    const message = build(CHANGE);

    expect(message).toContain('Service: iam');
    expect(message).toContain('Environment: prod');
    expect(message).toContain('Key: MFA_ENFORCEMENT');
  });

  it('records the request it came from', () => {
    // Ties the commit to the access log, which is how you reconstruct a session afterwards.
    const message = build(CHANGE);

    expect(message).toContain('Request-Id: 01JQZX');
    expect(message).toContain('Source-IP: 203.0.113.7');
  });

  it('records value hashes, not values', () => {
    const message = build(CHANGE);

    expect(message).toContain(`Old-Value-Hash: ${sha256('optional')}`);
    expect(message).toContain(`New-Value-Hash: ${sha256('all')}`);
  });

  it('never writes a secret value into the message', () => {
    // The property the whole format exists for. This message is pushed to GitHub and cloned
    // onto every laptop that has the repo.
    const message = build({
      ...CHANGE,
      keys: [{ key: 'SMTP_PASSWORD', oldValue: 'hunter2', newValue: 'correct-horse' }],
    });

    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('correct-horse');
    expect(message).toContain('Key: SMTP_PASSWORD');
  });

  it('proves a change happened even though it hides the values', () => {
    // A hash of the old and new value is enough to show they differ, which is what an auditor
    // needs, without being enough to recover either.
    const message = build({
      ...CHANGE,
      keys: [{ key: 'SMTP_PASSWORD', oldValue: 'hunter2', newValue: 'correct-horse' }],
    });
    const [, oldHash] = message.match(/Old-Value-Hash: (\S+)/) ?? [];
    const [, newHash] = message.match(/New-Value-Hash: (\S+)/) ?? [];

    expect(oldHash).not.toBe(newHash);
  });

  it('hashes structured values consistently', () => {
    // Lists and numbers are values too; hashing their JSON keeps one rule for every type.
    const message = build({
      ...CHANGE,
      keys: [{ key: 'FP_COMPONENTS', oldValue: ['ua'], newValue: ['ua', 'lang'] }],
    });

    expect(message).toContain(`New-Value-Hash: ${sha256(JSON.stringify(['ua', 'lang']))}`);
  });

  it('marks a key that did not exist before rather than hashing undefined', () => {
    const message = build({
      ...CHANGE,
      keys: [{ key: 'NEW_FLAG', oldValue: undefined, newValue: 'on' }],
    });

    expect(message).toContain('Old-Value-Hash: none');
  });

  it('marks a key that was deleted', () => {
    const message = build({
      ...CHANGE,
      keys: [{ key: 'OLD_FLAG', oldValue: 'on', newValue: undefined }],
    });

    expect(message).toContain('New-Value-Hash: none');
  });

  it('records every key when one save changes several', () => {
    const message = build({
      ...CHANGE,
      keys: [
        { key: 'A', oldValue: '1', newValue: '2' },
        { key: 'B', oldValue: '3', newValue: '4' },
      ],
    });

    expect(message).toContain('Key: A');
    expect(message).toContain('Key: B');
    expect(message.match(/Old-Value-Hash:/g)).toHaveLength(2);
  });

  it('keeps a multi-line audit message from breaking the trailer block', () => {
    // git parses trailers from the last paragraph. A message with its own blank lines would
    // otherwise split the block and lose the attribution.
    const message = build({ ...CHANGE, message: 'Tighten MFA\n\nBecause of the login spike' });
    const trailerBlock = message.split('\n\n').at(-1) ?? '';

    expect(trailerBlock).toContain('Actor: me@anudeep.pro');
    expect(trailerBlock).toContain('Key: MFA_ENFORCEMENT');
  });
});
