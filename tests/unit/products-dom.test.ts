// @vitest-environment jsdom
import { type ProductSummary, renderProducts } from '@config/src/views/pages.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The product list, parsed rather than pattern-matched.
 *
 * A string assertion sees `<form method="get">` in the markup and passes. A parser sees that the
 * tag was inside another form and dropped it — which is how a Search button came to submit a
 * publish. Anything about which control belongs to which form has to be asserted here.
 */
const product = (over: Partial<ProductSummary> = {}): ProductSummary => ({
  name: 'iam (1002)',
  service: 'iam',
  keys: 'MFA_ENFORCEMENT, SESSION_TTL',
  environments: [
    {
      name: 'dev',
      namespace: 'iam/dev',
      drafts: 1,
      pending: [{ key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all', secret: false }],
    },
  ],
  ...over,
});

const load = (over: Parameters<typeof renderProducts>[0] | null = null) => {
  document.body.innerHTML = String(
    renderProducts(over ?? { products: [product()], commit: 'a'.repeat(40) }),
  );
};

const formOf = (selector: string) =>
  (document.querySelector(selector) as HTMLInputElement | HTMLButtonElement | null)?.form;

beforeEach(() => load());

describe('the search box is its own form', () => {
  it('does not submit a publish', () => {
    // The defect: nested inside the publish form, the parser dropped the search form and every
    // Search click POSTed /publish — committing and pushing whatever was ticked.
    expect(formOf('input[name="q"]')?.getAttribute('action')).toBe('/');
    expect(formOf('input[name="q"]')?.getAttribute('method')).toBe('get');
  });

  it('is a different form from the publish one', () => {
    const search = formOf('input[name="q"]');
    const publish = formOf('input[name="namespace"]');

    expect(search).not.toBeNull();
    expect(publish).not.toBeNull();
    expect(search).not.toBe(publish);
    expect(publish?.getAttribute('action')).toBe('/publish');
  });

  it('carries the search button, not the publish button', () => {
    const buttons = [...document.querySelectorAll('button')];
    const searchButton = buttons.find((button) => button.textContent?.includes('Search'));

    expect(searchButton?.form?.getAttribute('action')).toBe('/');
  });

  it('keeps the product checkboxes with the publish form', () => {
    // They are what a publish acts on; in the wrong form they are simply not submitted.
    expect(formOf('input[name="namespace"]')?.getAttribute('action')).toBe('/publish');
  });
});

describe('a search result links where it says', () => {
  it('names an environment the service declares, not always dev', () => {
    load({
      products: [
        product({
          matched: ['SESSION_TTL'],
          environments: [
            { name: 'stage', namespace: 'iam/stage', drafts: 0, pending: [] },
            { name: 'prod', namespace: 'iam/prod', drafts: 0, pending: [] },
          ],
        }),
      ],
      commit: 'a'.repeat(40),
      query: 'SESSION',
    });

    const link = document.querySelector('a[href*="hl="]') as HTMLAnchorElement;

    expect(link.getAttribute('href')).toBe('/p/iam?env=stage&hl=SESSION_TTL');
  });
});
