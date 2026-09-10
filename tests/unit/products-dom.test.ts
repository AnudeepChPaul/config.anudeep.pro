// @vitest-environment jsdom
import { type ProductSummary, renderProducts } from '@config/src/views/pages.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The product list, parsed rather than pattern-matched.
 *
 * A string assertion sees `<form method="get">` in the markup and passes. A parser sees that the
 * tag was inside another form and dropped it — which is how a Search button came to submit a
 * publish. Anything about which control belongs to which form has to be asserted here.
 *
 * Publishing is gone with the direct-write cutover, but the hazard is not: the header still
 * carries a POST form beside the search box — Back up — so the same nesting mistake would now
 * make Search commit and push instead.
 */
const product = (over: Partial<ProductSummary> = {}): ProductSummary => ({
  name: 'iam',
  keys: ['MFA_ENFORCEMENT', 'SESSION_TTL'],
  environments: ['dev'],
  retiring: false,
  ...over,
});

const load = (over: Parameters<typeof renderProducts>[0] | null = null) => {
  document.body.innerHTML = String(
    renderProducts(over ?? { products: [product()], pendingBackup: 0 }),
  );
};

const formOf = (selector: string) =>
  (document.querySelector(selector) as HTMLInputElement | HTMLButtonElement | null)?.form;

beforeEach(() => load());

describe('the search box lives in the page header', () => {
  it('is in the header, not in the page body', () => {
    // One box, in the same place on every page that has one — rather than a box per page,
    // rendered wherever that page happened to put it.
    const input = document.querySelector('input[name="q"]');

    expect(input?.closest('.pagehead')).not.toBeNull();
    expect(input?.closest('.searchrow')).not.toBeNull();
  });

  it('appears once, not once per page section', () => {
    expect(document.querySelectorAll('input[name="q"]')).toHaveLength(1);
  });
});

describe('the search box is its own form', () => {
  it('does not submit a write', () => {
    // The defect: nested inside the publish form, the parser dropped the search form and every
    // Search click POSTed /publish — committing and pushing whatever was ticked. The form it
    // sits beside is /sync now, and the consequence of the same mistake is the same.
    expect(formOf('input[name="q"]')?.getAttribute('action')).toBe('/');
    expect(formOf('input[name="q"]')?.getAttribute('method')).toBe('get');
  });

  it('is a different form from the back-up one', () => {
    const search = formOf('input[name="q"]');
    const backup = [...document.querySelectorAll('form')].find(
      (form) => form.getAttribute('action') === '/sync',
    );

    expect(search).not.toBeNull();
    expect(backup).not.toBeUndefined();
    expect(search).not.toBe(backup);
    expect(backup?.getAttribute('method')).toBe('post');
  });

  it('carries the search button, not the back-up button', () => {
    const buttons = [...document.querySelectorAll('button')];
    const searchButton = buttons.find((button) => button.textContent?.includes('Search'));

    expect(searchButton?.form?.getAttribute('action')).toBe('/');
  });

  it('keeps the back-up button with the back-up form', () => {
    const buttons = [...document.querySelectorAll('button')];
    const backupButton = buttons.find((button) => button.textContent?.includes('Back up'));

    expect(backupButton?.form?.getAttribute('action')).toBe('/sync');
  });
});

describe('the search row is one row of controls', () => {
  // Search was a link-styled action at 13px and Clear was a hint at 12px — different sizes,
  // different colours, different treatments, sitting side by side. They are both actions on the
  // same row, so they are the same kind of thing and have to look like it.
  it('gives Search and Clear the same treatment', () => {
    load({ products: [product()], pendingBackup: 0, query: 'MFA' });
    const row = document.querySelector('.search') as HTMLElement;
    const controls = [...row.querySelectorAll('button, a')];

    expect(controls.map((control) => control.textContent?.trim().split(/\s+/)[0])).toEqual([
      'Search',
      'Clear',
    ]);
    for (const control of controls) {
      expect(control.className).toContain('linkbtn');
    }
  });

  it('offers Clear only when there is something to clear', () => {
    load();

    expect(document.querySelector('.search a')).toBeNull();
  });
});

describe('a search result links where it says', () => {
  it('names an environment the service declares, not always dev', () => {
    load({
      products: [product({ environments: ['stage', 'prod'] })],
      pendingBackup: 0,
      query: 'SESSION',
    });

    const link = document.querySelector('a[href*="hl="]') as HTMLAnchorElement;

    expect(link.getAttribute('href')).toBe('/p/iam?env=stage&hl=SESSION_TTL');
  });
});
