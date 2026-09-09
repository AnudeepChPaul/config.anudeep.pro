import { noticeFor } from '@config/src/views/notices.js';
import { describe, expect, it } from 'vitest';

/**
 * The wording of a notice belongs to the server.
 *
 * It used to travel as free text in the URL — `/?notice=Published%202%20change(s)` — which meant
 * anyone could send a link that rendered arbitrary words inside the console. Escaped, so not a
 * script, but a message in the product's own voice saying whatever the sender chose: "Published
 * successfully", or a support number to call. It also replayed on every reload, so a stale
 * confirmation reappeared long after the thing it confirmed.
 *
 * A code names an outcome the server already knows how to describe. Anything unrecognised
 * renders nothing at all, which is the only safe reading of input from a link.
 */
describe('turning an outcome code into a notice', () => {
  it('describes a publish, with the count it was given', () => {
    const notice = noticeFor('published', { n: 3 });
    expect(notice?.tone).toBe('done');
    expect(notice?.text).toContain('3');
  });

  it('says when a publish committed but did not reach the remote', () => {
    expect(noticeFor('published-unpushed', { n: 1 })?.text).toMatch(/not yet pushed|GitHub/i);
  });

  // A failure is not a confirmation: it must not be swept away on a timer.
  it('marks a failure as a problem, so nothing clears it on a timer', () => {
    expect(noticeFor('publish-failed')?.tone).toBe('problem');
    expect(noticeFor('nothing-selected')?.tone).toBe('problem');
  });

  it('renders nothing for a code it does not know', () => {
    expect(noticeFor('anything-else')).toBeNull();
    expect(noticeFor('<b>hi</b>')).toBeNull();
  });

  it('renders nothing when there is no code at all', () => {
    expect(noticeFor(undefined)).toBeNull();
    expect(noticeFor('')).toBeNull();
  });

  // The count comes from a query string, so it is whatever someone typed.
  it('refuses a count that is not a plain number', () => {
    expect(noticeFor('published', { n: Number.NaN })?.text).not.toContain('NaN');
    expect(noticeFor('published', { n: -4 })?.text).not.toContain('-4');
  });

  it('describes a dropped draft', () => {
    expect(noticeFor('dropped')?.tone).toBe('done');
  });
});

/**
 * The property the codes exist for.
 *
 * A link is untrusted input. Before this, `/?notice=<anything>` rendered that text inside the
 * console in its own voice — escaped, so never a script, but a sentence a reader has every
 * reason to believe. Nothing a URL carries can produce wording now: the code either names an
 * outcome this module knows, or nothing is shown.
 */
describe('what a link cannot do', () => {
  it('cannot put words on the page, however they are dressed up', () => {
    for (const attempt of [
      'Published successfully',
      'call+1-800-555-0100',
      '<script>alert(1)</script>',
      'published; drop table',
      'PUBLISHED',
      'published ',
      ' published',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(noticeFor(attempt), attempt).toBeNull();
    }
  });

  it('answers only to exact codes it defines', () => {
    expect(noticeFor('published')).not.toBeNull();
    expect(noticeFor('publishe')).toBeNull();
    expect(noticeFor('publishedx')).toBeNull();
  });
});
