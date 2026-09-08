// @vitest-environment jsdom
import {
  type KeyRow,
  type ProductSummary,
  renderDrafts,
  renderProduct,
  renderProducts,
} from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

/**
 * One page header, in one place, on every page.
 *
 * Each page grew its own: the product list had an h1 in a flex row, a product page had a
 * breadcrumb and a separate facts line inside the toolbar slot, and /drafts had a breadcrumb and
 * an h1 and no facts at all. Navigating moved the title both down the page and across it, which
 * is what made the console feel like several applications.
 *
 * These assert the SHAPE — same containers, same order, same rows present whether or not they
 * hold anything — because that is what stops the header moving.
 */
const product = (over: Partial<ProductSummary> = {}): ProductSummary => ({
  name: 'iam (1002)',
  service: 'iam',
  keys: 'MFA_ENFORCEMENT',
  environments: [{ name: 'dev', namespace: 'iam/dev', drafts: 1, pending: [] }],
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
  products: String(renderProducts({ products: [product()], commit: 'a'.repeat(40) })),
  product: String(
    renderProduct({
      service: 'iam',
      environments: [{ name: 'dev', namespace: 'iam/dev', drafts: 0, pending: [] }],
      active: 'dev',
      rows,
      commit: 'a'.repeat(40),
    }),
  ),
  drafts: String(
    renderDrafts({
      drafts: [{ namespace: 'iam/dev', saves: [{ keys: ['A'], actor: 'me', at: Date.now() }] }],
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

  it('puts the rows in one order: search, breadcrumb, title, facts', () => {
    for (const html of Object.values(pages())) {
      const head = headerOf(html);
      const order = [...head.children].map((child) => child.className.split(' ')[0]);

      expect(order).toEqual(['searchrow', 'crumb', 'titlerow', 'facts']);
    }
  });

  it('renders every row even when it holds nothing, so nothing moves', () => {
    // The rows carry fixed heights in CSS; they have to be PRESENT for that to hold. A page
    // that omits its breadcrumb pulls its own title up by a line.
    for (const html of Object.values(pages())) {
      const head = headerOf(html);

      expect(head.querySelector('.searchrow')).not.toBeNull();
      expect(head.querySelector('.crumb')).not.toBeNull();
      expect(head.querySelector('.titlerow h1')).not.toBeNull();
      expect(head.querySelector('.facts')).not.toBeNull();
    }
  });

  it('reads as one horizontal trail, not a stack', () => {
    // "All products › iam", in one row, rather than a lone link sitting above the title.
    document.body.innerHTML = pages().product;
    const crumb = document.querySelector('.pagehead .crumb') as HTMLElement;

    // One row, three parts in order: the link back, the separator, where you are. The spacing
    // between them is the row's gap, not text, so this asserts the parts rather than the string.
    expect([...crumb.children].map((child) => child.textContent)).toEqual([
      'All products',
      '›',
      'iam',
    ]);
    expect(crumb.querySelector('a')?.getAttribute('href')).toBe('/');
    expect(crumb.querySelector(':scope > span:last-child')?.tagName).toBe('SPAN');
  });

  it('names where you are on the drafts page too', () => {
    document.body.innerHTML = pages().drafts;
    const crumb = document.querySelector('.pagehead .crumb') as HTMLElement;

    expect([...crumb.children].map((child) => child.textContent)).toEqual([
      'All products',
      '›',
      'Unpublished drafts',
    ]);
  });

  it('right-aligns page actions on the title row, not below it', () => {
    const busy = String(
      renderProduct({
        service: 'iam',
        environments: [
          {
            name: 'dev',
            namespace: 'iam/dev',
            drafts: 2,
            pending: [{ key: 'A', from: '1', to: '2', secret: false }],
          },
        ],
        active: 'dev',
        rows,
        commit: 'a'.repeat(40),
      }),
    );
    const head = headerOf(busy);

    const action = head.querySelector('.titlerow .actions-right button');
    expect(action?.textContent).toMatch(/Publish all/);
  });
});
