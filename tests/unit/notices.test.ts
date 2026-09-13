import { noticeFor } from '@config/src/views/notices.js';
import { describe, expect, it } from 'vitest';

/**
 * The wording of a notice belongs to the server.
 *
 * A code names an outcome the server already knows how to describe. Anything unrecognised
 * renders nothing at all. Draft and publish codes are gone with the draft model: a saved
 * change is live, and git sync is a back-up — never "not yet in effect".
 */
describe('turning an outcome code into a notice', () => {
  it('describes a live save', () => {
    const notice = noticeFor('saved');
    expect(notice?.tone).toBe('done');
    expect(notice?.text).toMatch(/live now/i);
    expect(notice?.text).not.toMatch(/draft|publish/i);
  });

  it('describes a promotion that is already live', () => {
    const notice = noticeFor('promoted', { n: 2 });
    expect(notice?.tone).toBe('done');
    expect(notice?.text).toContain('2');
    expect(notice?.text).not.toMatch(/draft|publish|staged|not yet/i);
  });

  it('describes a key deletion', () => {
    const notice = noticeFor('deleted', { n: 2 });
    expect(notice?.tone).toBe('done');
    expect(notice?.text).toContain('2');
    expect(notice?.text).not.toMatch(/draft|publish/i);
  });

  it('describes variables added to a product', () => {
    const notice = noticeFor('keys-added', { n: 2 });
    expect(notice?.tone).toBe('done');
    expect(notice?.text).toContain('2');
    expect(notice?.text).toMatch(/live now/i);
  });

  it('describes a successful back-up', () => {
    expect(noticeFor('backed-up', { n: 3 })?.text).toMatch(/back/i);
    expect(noticeFor('backed-up', { n: 3 })?.text).not.toMatch(/publish/i);
  });

  it('marks back-up and delete failures as problems', () => {
    expect(noticeFor('backup-failed')?.tone).toBe('problem');
    expect(noticeFor('backup-deferred')?.tone).toBe('problem');
    expect(noticeFor('backup-deferred')?.text).not.toMatch(/unchanged/i);
    expect(noticeFor('backup-no-remote')?.tone).toBe('problem');
    expect(noticeFor('delete-failed')?.tone).toBe('problem');
  });

  it('describes creating an environment as live, not drafted', () => {
    const notice = noticeFor('created');
    expect(notice?.tone).toBe('done');
    expect(notice?.text).toMatch(/live|defaults/i);
    expect(notice?.text).not.toMatch(/draft|publish|not yet/i);
  });

  it('describes retirement as already visible to consumers', () => {
    expect(noticeFor('retiring')?.text).not.toMatch(/draft|publish|until/i);
    expect(noticeFor('retirement-cancelled')?.text).not.toMatch(/draft|publish/i);
  });

  it('says when nothing was selected for Promote or Delete', () => {
    expect(noticeFor('nothing-selected')?.tone).toBe('problem');
    expect(noticeFor('nothing-selected')?.text).not.toMatch(/unpublished|draft/i);
  });

  it('does not know the removed draft and publish codes', () => {
    for (const gone of [
      'published',
      'published-unpushed',
      'publish-failed',
      'publish-stale',
      'drafted',
      'dropped',
      'nothing-staged',
      'drop-failed',
    ]) {
      expect(noticeFor(gone), gone).toBeNull();
    }
  });

  it('renders nothing for a code it does not know', () => {
    expect(noticeFor('anything-else')).toBeNull();
    expect(noticeFor('<b>hi</b>')).toBeNull();
  });

  it('renders nothing when there is no code at all', () => {
    expect(noticeFor(undefined)).toBeNull();
    expect(noticeFor('')).toBeNull();
  });

  it('refuses a count that is not a plain number', () => {
    expect(noticeFor('promoted', { n: Number.NaN })?.text).not.toContain('NaN');
    expect(noticeFor('promoted', { n: -4 })?.text).not.toContain('-4');
  });
});

describe('what a link cannot do', () => {
  it('cannot put words on the page, however they are dressed up', () => {
    for (const attempt of [
      'Published successfully',
      'Live now in evil/prod',
      'call+1-800-555-0100',
      '<script>alert(1)</script>',
      'saved; drop table',
      'SAVED',
      'saved ',
      ' saved',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(noticeFor(attempt), attempt).toBeNull();
    }
  });

  it('answers only to exact codes it defines', () => {
    expect(noticeFor('saved')).not.toBeNull();
    expect(noticeFor('save')).toBeNull();
    expect(noticeFor('savedx')).toBeNull();
  });
});
