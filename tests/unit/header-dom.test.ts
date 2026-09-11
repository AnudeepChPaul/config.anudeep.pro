// @vitest-environment jsdom
import {
  type KeyRow,
  type ProductSummary,
  renderFeatures,
  renderProduct,
  renderProducts,
} from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

/**
 * One page header, in one place, on every page.
 *
 * Each page grew its own: the product list had an h1 in a flex row, a product page had a
 * breadcrumb and a separate facts line inside the toolbar slot, and a third page had a breadcrumb
 * and an h1 and no facts at all. Navigating moved the title both down the page and across it,
 * which is what made the console feel like several applications.
 *
 * The third page was /drafts, which the direct-write cutover removed. Features took its place:
 * what matters is that a THIRD page is checked, so the header cannot quietly become a
 * two-page convention that the next screen is free to ignore.
 *
 * These assert the SHAPE — same containers, same order, same rows present whether or not they
 * hold anything — because that is what stops the header moving.
 */
const product = (over: Partial<ProductSummary> = {}): ProductSummary => ({
  name: 'iam',
  environments: ['dev'],
  retiring: false,
  ...over,
});

const rows: KeyRow[] = [
  {
    key: 'MFA_ENFORCEMENT',
    definition: { type: 'string', secret: false } as unknown as KeyRow['definition'],
    value: 'all',
  },
];

const pages = () => ({
  products: String(renderProducts({ products: [product()] })),
  product: String(
    renderProduct({
      service: 'iam',
      environment: 'dev',
      environments: ['dev'],
      etag: 'e',
      rows,
      version: 1,
      next: null,
      retiring: false,
      missing: false,
    }),
  ),
  features: String(
    renderFeatures({
      flags: { NEW_CHECKOUT: { dev: true } },
      environment: 'dev',
      environments: ['dev'],
    }),
  ),
});

const headerOf = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector('.pagehead') as HTMLElement;
};

describe('every page has the same header', () => {
  it('renders one, on all three', () => {
    const all = pages();

    for (const [name, html] of Object.entries(all)) {
      expect(headerOf(html), `${name} has a page header`).not.toBeNull();
    }
  });

  it('puts the rows in one order: search, notice, title, facts', () => {
    // No separate breadcrumb row. The title IS the trail, so there is one thing to read rather
    // than a crumb saying where you are above a heading repeating it.
    //
    // The notice row sits between the search and the title and is rendered on every page,
    // holding a notice or nothing, so one arriving does not push the title down the page.
    for (const html of Object.values(pages())) {
      const head = headerOf(html);
      const order = [...head.children].map((child) => child.className.split(' ')[0]);

      expect(order).toEqual(['searchrow', 'noticerow', 'titlerow', 'facts']);
    }
  });

  it('renders every row even when it holds nothing, so nothing moves', () => {
    // The rows carry fixed heights in CSS; they have to be PRESENT for that to hold. A page
    // that omits its breadcrumb pulls its own title up by a line.
    for (const html of Object.values(pages())) {
      const head = headerOf(html);

      expect(head.querySelector('.searchrow')).not.toBeNull();
      expect(head.querySelector('.titlerow h1')).not.toBeNull();
      expect(head.querySelector('.facts')).not.toBeNull();
    }
  });

  it('makes the heading itself the trail', () => {
    // Inside a product the heading reads "Products › Iam", where Products is the link back.
    document.body.innerHTML = pages().product;
    const h1 = document.querySelector('.pagehead h1') as HTMLElement;

    expect([...h1.children].map((child) => child.textContent)).toEqual(['Products', '›', 'Iam']);
    expect(h1.querySelector('a')?.getAttribute('href')).toBe('/');
  });

  it('leaves the landing page a plain heading, with nothing to go back to', () => {
    document.body.innerHTML = pages().products;
    const h1 = document.querySelector('.pagehead h1') as HTMLElement;

    expect(h1.textContent?.trim()).toBe('Products');
    expect(h1.querySelector('a')).toBeNull();
  });

  it('puts each key in a list row, not a spaced field', () => {
    document.body.innerHTML = pages().product;
    const key = document.querySelector('[data-key="MFA_ENFORCEMENT"]')?.closest('.keyrow') as HTMLElement;
    expect(key.classList.contains('row')).toBe(true);
    expect(key.classList.contains('field')).toBe(false);
  });

  it('lists keys for a missing environment as chips in the same row language', () => {
    document.body.innerHTML = String(
      renderProduct({
        service: 'iam',
        environment: 'dev',
        environments: ['dev'],
        etag: null,
        rows,
        version: 0,
        next: null,
        retiring: false,
        missing: true,
      }),
    );
    expect(document.querySelector('ul.hint')).toBeNull();
    expect(document.querySelector('.row-keys .chip-item')?.textContent).toBe('MFA_ENFORCEMENT');
    expect(document.querySelector('.actionline button')?.textContent).toMatch(/Create from schema/);
  });

  it('names where you are on the third page too', () => {
    document.body.innerHTML = pages().features;
    const h1 = document.querySelector('.pagehead h1') as HTMLElement;

    expect(h1.textContent).toContain('Features');
  });

  it('right-aligns page actions on the title row, not below it', () => {
    const busy = String(
      renderProduct({
        service: 'iam',
        environment: 'dev',
        environments: ['dev'],
        etag: 'e',
        rows,
        version: 2,
        next: null,
        retiring: false,
        missing: false,
      }),
    );
    const head = headerOf(busy);

    // This asks whether the page actions are IN the title row rather than which one comes
    // first. Publish all is gone with the draft model; Retire is the action that survived, and
    // the placement rule it was asserting is unchanged.
    const actions = [...head.querySelectorAll('.titlerow .actions-right button')].map(
      (button) => button.textContent ?? '',
    );

    expect(
      actions.some((label) => /Retire/.test(label)),
      'retire',
    ).toBe(true);
    expect(head.querySelector('.facts .actions-right'), 'not below the title').toBeNull();
  });
});
