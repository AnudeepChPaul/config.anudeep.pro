// @vitest-environment jsdom
import { type ProductSummary, renderConfirmation, renderProducts, renderSyncPreview } from '@config/src/views/pages.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The product list, parsed rather than pattern-matched.
 *
 * A string assertion sees `<form method="get">` in the markup and passes. A parser sees that the
 * tag was inside another form and dropped it — which is how a Search button came to submit a
 * publish. Anything about which control belongs to which form has to be asserted here.
 *
 * Publishing is gone with the direct-write cutover, but the hazard is not: Search must stay
 * its own GET form, never nested inside another write.
 */
const product = (over: Partial<ProductSummary> = {}): ProductSummary => ({
  name: 'iam',
  keys: ['MFA_ENFORCEMENT', 'SESSION_TTL'],
  environments: ['dev'],
  retiring: false,
  ...over,
});

const load = (over: Parameters<typeof renderProducts>[0] | null = null) => {
  document.body.innerHTML = String(renderProducts(over ?? { products: [product()] }));
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
    expect(formOf('input[name="q"]')?.getAttribute('action')).toBe('/');
    expect(formOf('input[name="q"]')?.getAttribute('method')).toBe('get');
  });

  it('does not nest inside a /sync POST', () => {
    expect(
      [...document.querySelectorAll('form')].some(
        (form) => form.getAttribute('action') === '/sync',
      ),
    ).toBe(false);
    expect(formOf('input[name="q"]')?.getAttribute('action')).toBe('/');
  });

  it('carries the search button on the search form', () => {
    const buttons = [...document.querySelectorAll('button')];
    const searchButton = buttons.find((button) => button.textContent?.includes('Search'));

    expect(searchButton?.form?.getAttribute('action')).toBe('/');
  });
});

describe('manual git backup', () => {
  it('has no Back up control and no backup count on a clean list', () => {
    expect(document.body.textContent).not.toMatch(/Back up/);
    expect(document.body.textContent).not.toMatch(/awaiting backup/);
    expect(document.body.textContent).not.toMatch(/Sync changes now/);
  });

  it('offers Sync changes now as a linkbtn when there is pending work', () => {
    load({ products: [product()], showSyncNow: true });
    const link = [...document.querySelectorAll('a')].find((node) =>
      node.textContent?.includes('Sync changes now'),
    );

    expect(link?.classList.contains('linkbtn')).toBe(true);
    expect(link?.getAttribute('href')).toBe('/sync');
    expect(link?.getAttribute('hx-get')).toBe('/sync');
    expect(link?.getAttribute('hx-target')).toBe('#sync-preview');
    expect(document.querySelector('#sync-preview')).not.toBeNull();
  });

  it('puts Auto sync in the footer, not the title row', () => {
    load({ products: [product()], autoSync: false, build: '1' });
    const footer = document.querySelector('.pagefoot form.autosync');
    const heading = document.querySelector('.titlerow');

    expect(footer).not.toBeNull();
    expect(footer?.querySelector('input[type="checkbox"]')?.hasAttribute('checked')).toBe(false);
    expect(heading?.textContent).not.toMatch(/Auto sync/);
  });
});

describe('the search row is one row of controls', () => {
  // Search was a link-styled action at 13px and Clear was a hint at 12px — different sizes,
  // different colours, different treatments, sitting side by side. They are both actions on the
  // same row, so they are the same kind of thing and have to look like it.
  it('gives Search and Clear the same treatment', () => {
    load({ products: [product()], query: 'MFA' });
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

describe('a product row lines up as a list row', () => {
  it('marks how many saved keys have not reached Git', () => {
    load({ products: [product({ unsynced: 3 })], unsynced: 3 });
    const row = document.querySelector('.rows .row') as HTMLElement;
    expect(row.querySelector('.chip.wait')?.textContent).toBe('3 unsynced');
    expect(document.querySelector('.facts')?.textContent).toMatch(/3 unsynced/);
  });

  it('keeps the name, environments and key chips as siblings in one row', () => {
    const row = document.querySelector('.rows .row') as HTMLElement;
    expect(row.querySelector('.pname')).not.toBeNull();
    expect(row.querySelector('.hint')?.textContent).toContain('Dev');
    expect(row.querySelector('.row-keys')).not.toBeNull();
    expect(row.querySelector('.row-keys a.chip-item')?.getAttribute('href')).toContain('/p/iam');
  });

  it('keeps retirement actions together at the end of the row', () => {
    load({ products: [product({ retiring: true })] });
    const end = document.querySelector('.rows .row .row-end') as HTMLElement;
    expect(end.textContent).toMatch(/retiring/);
    expect(end.querySelector('form')?.getAttribute('action')).toBe('/p/iam/retire');
    const cancel = [...end.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Cancel retirement'),
    );
    const archive = [...end.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Archive'),
    );
    expect(cancel?.className).toContain('linkbtn');
    expect(archive?.className).toContain('linkbtn');
    expect(archive?.className).toContain('no');
  });
});

describe('a retire confirmation uses link actions on the right', () => {
  it('styles Yes, continue and Cancel as linkbtns in an end-aligned action line', () => {
    document.body.innerHTML = String(
      renderConfirmation({
        title: 'Retire iam?',
        message: 'Consumers will see the retirement mark immediately.',
        action: '/p/iam/retire',
        fields: { retiring: 'true' },
        back: '/p/iam',
      }),
    );
    const line = document.querySelector('.actionline') as HTMLElement;
    const confirm = line.querySelector('button');
    const cancel = line.querySelector('a');

    expect(line.classList.contains('end')).toBe(true);
    expect(confirm?.classList.contains('linkbtn')).toBe(true);
    expect(confirm?.getAttribute('name')).toBe('confirm');
    expect(cancel?.classList.contains('linkbtn')).toBe(true);
    expect(cancel?.classList.contains('no')).toBe(true);
  });
});

describe('a sync confirmation uses link actions on the right', () => {
  it('styles Confirm and Cancel as linkbtns in an end-aligned action line', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [{ path: 'config/iam/dev.yaml', keys: ['SESSION_TTL'], actor: 'ops@anudeep.pro' }],
        unpushed: [],
      }),
    );
    const line = document.querySelector('#sync-card .actionline') as HTMLElement;
    const confirm = line.querySelector('button');
    const cancel = line.querySelector('a');

    expect(line.classList.contains('end')).toBe(true);
    expect(confirm?.classList.contains('linkbtn')).toBe(true);
    expect(confirm?.getAttribute('name')).toBe('confirm');
    expect(cancel?.classList.contains('linkbtn')).toBe(true);
    expect(cancel?.classList.contains('no')).toBe(true);
    expect(document.querySelector('#sync-card .searchrow')).toBeNull();
    expect(document.querySelector('#sync-card .noticerow')).toBeNull();
  });
});

describe('a search result links where it says', () => {
  it('names an environment the service declares, not always dev', () => {
    load({
      products: [product({ environments: ['stage', 'prod'] })],
      query: 'SESSION',
    });

    const link = document.querySelector('a[href*="hl="]') as HTMLAnchorElement;

    expect(link.getAttribute('href')).toBe('/p/iam?env=stage&hl=SESSION_TTL#found');
  });
});
