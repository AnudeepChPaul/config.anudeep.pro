// @vitest-environment jsdom

import { renderProduct, renderProducts } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

/**
 * One notice line, in a slot that is always there.
 *
 * Before this a notice was a plain card in the page body, identical whether it reported a
 * publish or a failure, with nothing to dismiss it and no way to tell the two apart at a glance.
 * A confirmation stayed until the next navigation; a failure could be swept away by the same
 * 5s timer as a success, so an error nobody read was an error nobody handled.
 */
const load = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector('[data-notice]');
};

const slot = () => document.querySelector('.noticerow');

const products = (over: Record<string, unknown> = {}) =>
  String(
    renderProducts({
      products: [],
      fragment: true,
      ...over,
    } as Parameters<typeof renderProducts>[0]),
  );

describe('the notice banner', () => {
  it('renders a confirmation as transient, so it clears itself', () => {
    const banner = load(products({ notice: { tone: 'done', text: 'Published 3 changes.' } }));
    expect(banner?.textContent).toContain('Published 3 changes.');
    expect(banner?.hasAttribute('data-transient')).toBe(true);
  });

  // An error swept away on a timer is an error nobody handled.
  it('keeps a problem on the page', () => {
    const banner = load(products({ notice: { tone: 'problem', text: 'Publishing failed.' } }));
    expect(banner?.hasAttribute('data-transient')).toBe(false);
  });

  it('tells the two apart by class, not only by wording', () => {
    const done = load(products({ notice: { tone: 'done', text: 'x' } }))?.className;
    const problem = load(products({ notice: { tone: 'problem', text: 'y' } }))?.className;
    expect(done).not.toBe(problem);
  });

  it('offers a dismiss control on both, since the operator asked to close them', () => {
    for (const tone of ['done', 'problem'] as const) {
      const banner = load(products({ notice: { tone, text: 'x' } }));
      expect(banner?.querySelector('[data-dismiss]'), tone).toBeTruthy();
    }
  });

  // Without JS the dismiss has to be a link back to the page without the code, or it does
  // nothing at all for a reader who has scripting off.
  it('dismisses through a link, so it works with no script', () => {
    const banner = load(products({ notice: { tone: 'done', text: 'x' } }));
    const dismiss = banner?.querySelector('[data-dismiss]');
    expect(dismiss?.tagName).toBe('A');
    expect(dismiss?.getAttribute('href')).toBeTruthy();
  });

  it('renders nothing at all when there is no notice', () => {
    expect(load(products())).toBeNull();
  });

  // The whole point of the reserved row: a notice arriving must not push the page down.
  it('keeps the row even with nothing to say, so nothing shifts when something arrives', () => {
    load(products());
    expect(slot(), 'the row is rendered empty').toBeTruthy();
    expect(slot()?.textContent?.trim()).toBe('');
  });

  it('puts the notice in that row, between the search and the title', () => {
    load(products({ notice: { tone: 'done', text: 'Published 3 changes.' } }));
    const rows = [...(document.querySelector('.pagehead')?.children ?? [])].map((r) => r.className);
    expect(rows).toEqual(['searchrow', 'noticerow', 'titlerow', 'facts']);
    expect(slot()?.querySelector('[data-notice]')).toBeTruthy();
  });

  it('appears on the product page too, in the same shape', () => {
    // The drafts page this used to check is gone with the draft model. The assertion was never
    // about drafts: it is that the notice slot is the same shape on a SECOND page, so a notice
    // cannot grow its own local variant on one screen. The product page is that second page now.
    const banner = load(
      String(
        renderProduct({
          service: 'iam',
          environment: 'dev',
          environments: ['dev'],
          etag: 'e',
          rows: [],
          version: 1,
          next: null,
          retiring: false,
          missing: false,
          notice: { tone: 'done', text: 'Saved.' },
          fragment: true,
        }),
      ),
    );
    expect(banner?.hasAttribute('data-transient')).toBe(true);
  });
});
