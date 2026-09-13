// @vitest-environment jsdom
import {
  type KeyRow,
  type ProductSummary,
  renderProduct,
  renderProducts,
  renderSyncPreview,
} from '@config/src/views/pages.js';
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

  it('opens a changelog with time and before/after on the unsynced chip', () => {
    load({
      products: [product({ unsynced: 1 })],
      entries: [
        {
          actor: 'ops@anudeep.pro',
          path: 'config/iam/dev.yaml',
          keys: ['SESSION_TTL'],
          revision: '1',
          timestamp: '2026-09-11T00:00:00.000Z',
        },
      ],
      changesByPath: {
        'config/iam/dev.yaml': [{ key: 'SESSION_TTL', from: 30, to: 60 }],
      },
    });
    const peek = document.querySelector('.product-info .unsynced-badge') as HTMLElement;
    expect(peek?.querySelector('.chip.wait')?.textContent).toMatch(/1 unsynced/);
    expect(peek.querySelector('.detail h3')?.textContent).toBe('Changelog');
    expect(peek.querySelector('.detail .hint')?.textContent).toBe('11 Sep 2026, 00:00 UTC');
    expect(peek.querySelector('.detail .sync-env-name')?.textContent).toBe('Dev');
    expect(peek.querySelector('.detail .sync-tree')).not.toBeNull();
    expect(peek.querySelector('.detail .sync-vars')).not.toBeNull();
    expect(peek.querySelector('.was')?.textContent).toBe('30');
    expect(peek.querySelector('.is')?.textContent).toBe('60');
  });

  it('opens Add a product through #page so the console tabs stay', () => {
    const link = [...document.querySelectorAll('a')].find((node) =>
      node.textContent?.includes('Add a product'),
    );
    expect(link?.getAttribute('href')).toBe('/p/new');
    expect(link?.getAttribute('hx-get')).toBe('/p/new');
    expect(link?.getAttribute('hx-target')).toBe('#page');
    expect(link?.getAttribute('hx-push-url')).toBe('true');
  });

  it('opens a product through #page so the footer is not replaced', () => {
    const link = document.querySelector('a.pname');
    expect(link?.getAttribute('hx-target')).toBe('#page');
    expect(link?.getAttribute('hx-get')).toBe('/p/iam');
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

  it('shows two variable chips and how many more there are', () => {
    load({
      products: [
        product({
          keys: ['MFA_ENFORCEMENT', 'SESSION_TTL', 'SMTP_HOST', 'SMTP_PORT'],
        }),
      ],
    });
    const chips = [...document.querySelectorAll('.row-keys a.chip-item')].map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(['MFA_ENFORCEMENT', 'SESSION_TTL']);
    expect(document.querySelector('.row-keys .hint')?.textContent).toBe('(+ 2)');
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

  it('asks to archive on the retiring row, not on a separate confirmation page', () => {
    load({
      products: [product({ retiring: true })],
      retiringOnly: true,
      archiveAsk: { service: 'iam', kind: 'confirm', base: 'etag' },
    });
    const ask = document.querySelector('.archive-ask') as HTMLElement;
    expect(ask.textContent).toMatch(/removes all live configuration/);
    expect(ask.querySelector('form')?.getAttribute('action')).toBe('/p/iam/archive');
    expect(ask.querySelector('input[name="base"]')?.getAttribute('value')).toBe('etag');
    expect(ask.querySelector('a')?.getAttribute('href')).toBe('/p/retiring');
    expect(document.querySelector('.card p')).toBeNull();
    expect(document.querySelector('.row-keys')).toBeNull();
    expect(document.querySelector('.row-end')).not.toBeNull();
  });

  it('asks to force-archive on that same row when an archive already exists', () => {
    load({
      products: [product({ retiring: true })],
      retiringOnly: true,
      archiveAsk: { service: 'iam', kind: 'force', base: 'etag' },
    });
    const ask = document.querySelector('.archive-ask') as HTMLElement;
    expect(ask.textContent).toContain('an archive already exists for this product');
    expect(ask.textContent).toContain('Force retire anyway?');
    expect(ask.querySelector('input[name="force"]')?.getAttribute('value')).toBe('yes');
    expect([...ask.querySelectorAll('form')].map((form) => form.getAttribute('action'))).toEqual([
      '/p/iam/archive',
      '/p/iam/retire',
    ]);
    expect(document.querySelector('.row-keys')).toBeNull();
    expect(document.querySelector('.row-end')).not.toBeNull();
  });
});

describe('a retire confirmation asks inline on the product title row', () => {
  const page = (over: { retireAsk?: 'confirm' | 'force' } = {}) =>
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
        ...over,
      }),
    );

  it('asks beside Retire instead of opening a confirmation page', () => {
    document.body.innerHTML = page({ retireAsk: 'confirm' });
    const ask = document.querySelector('.titlerow .retire-ask') as HTMLElement;
    expect(ask.textContent).toMatch(/retirement mark immediately/);
    expect(ask.querySelector('button')?.textContent).toMatch(/Yes, continue/);
    expect(ask.querySelector('button')?.className).toContain('linkbtn');
    expect(ask.querySelector('button')?.getAttribute('name')).toBe('confirm');
    expect(ask.querySelector('a')?.textContent).toMatch(/Cancel/);
    expect(ask.querySelector('form')?.getAttribute('hx-target')).toBe('#page');
    expect(document.querySelector('h1')?.textContent).not.toMatch(/Retire iam/);
    expect(document.querySelector('.keyrow, #config-form, .tabs')).toBeTruthy();
  });

  it('asks to force retire inline when an archive already exists', () => {
    document.body.innerHTML = page({ retireAsk: 'force' });
    const ask = document.querySelector('.titlerow .retire-ask') as HTMLElement;
    const force = [...ask.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('Force retire anyway?'),
    );
    expect(ask.textContent).toContain('an archive already exists for this product');
    expect(force?.className).toContain('linkbtn');
    expect(force?.className).toContain('no');
    expect(force?.closest('form')?.getAttribute('action')).toBe('/p/iam/retire');
    expect(
      [...(force?.closest('form')?.querySelectorAll('input') ?? [])].some(
        (input) => input.name === 'force' && input.value === 'yes',
      ),
    ).toBe(true);
    expect(ask.querySelector('a')?.textContent).toMatch(/Cancel/);
  });
});

describe('adding a variable on the first environment', () => {
  const page = (over: Partial<Parameters<typeof renderProduct>[0]> = {}) =>
    String(
      renderProduct({
        service: 'iam',
        environment: 'dev',
        environments: ['dev', 'prod'],
        etag: 'e',
        rows: [],
        version: 1,
        next: 'prod',
        retiring: false,
        missing: false,
        ...over,
      }),
    );

  it('docks Confirm and Cancel on the toolbar and the draft under it, only on the first environment', () => {
    document.body.innerHTML = page();
    const live = document.querySelector('.product-live') as HTMLElement;
    const form = live.querySelector('#add-keys') as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('/p/iam/add-keys');
    expect(live.querySelector('#config-form')).toBeTruthy();
    const idle = document.querySelector('#config-form .idle') as HTMLElement;
    expect(idle.querySelector('[data-open-add-keys]')?.textContent).toMatch(/\+ Add variable/);
    expect(idle.querySelector('[data-open-add-keys] button')?.getAttribute('form')).toBe('add-keys');
    expect((form.querySelector('[data-add-keys-panel]') as HTMLElement).hidden).toBe(true);
    const confirm = form.querySelector('[data-add-keys-confirm]') as HTMLElement;
    expect(confirm.hidden).toBe(false);
    expect((form.querySelector('[data-add-keys-submit]') as HTMLElement).hidden).toBe(true);
    expect(confirm.querySelector('.linkbtn.go')?.textContent).toMatch(/Confirm/);
    expect(form.querySelector('[data-cancel-add-keys]')?.textContent).toMatch(/Cancel/);
    const rows = form.querySelector('#key-rows') as HTMLElement;
    expect(confirm.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.querySelector('[data-key-row]')).toBeTruthy();
    expect(document.querySelector('#config-form #key-rows')).toBeNull();
    document.body.innerHTML = page({ environment: 'prod', next: null });
    expect(document.querySelector('#add-keys')).toBeNull();
    document.body.innerHTML = page({ missing: true });
    expect(document.querySelector('#add-keys')).toBeNull();
  });
});

describe('a product key names its type on the line', () => {
  const definition = (over: Record<string, unknown> = {}) =>
    ({ type: 'string', secret: false, ...over }) as KeyRow['definition'];

  it('shows the type, and quoted allowed values when the key has them', () => {
    document.body.innerHTML = String(
      renderProduct({
        service: 'iam',
        environment: 'dev',
        environments: ['dev', 'prod'],
        etag: 'e',
        rows: [
          {
            key: 'SESSION_TTL',
            definition: definition({ type: 'int', description: 'Seconds until a session expires' }),
            value: 900,
          },
          {
            key: 'MFA_ENFORCEMENT',
            definition: definition({ type: 'enum', values: ['optional', 'admins', 'all'] }),
            value: 'all',
            elsewhere: { prod: 'admins' },
          },
        ],
        version: 1,
        next: 'prod',
        retiring: false,
        missing: false,
      }),
    );
    const ttl = [...document.querySelectorAll('.keyrow')].find((row) =>
      row.textContent?.includes('SESSION_TTL'),
    ) as HTMLElement;
    const mfa = [...document.querySelectorAll('.keyrow')].find((row) =>
      row.textContent?.includes('MFA_ENFORCEMENT'),
    ) as HTMLElement;
    expect(ttl.querySelector('.keyline .hint')?.textContent).toBe('(int)');
    expect(ttl.querySelector('.keydesc')?.textContent).toBe('Seconds until a session expires');
    expect(ttl.querySelector('.keyline')?.nextElementSibling?.className).toContain('keydesc');
    expect(ttl.querySelector('.keyline .peek')).toBeNull();
    expect(mfa.querySelector('.keydesc')).toBeNull();
    expect(mfa.querySelector('.keyline .hint')?.textContent).toBe(
      '(enum, "optional" || "admins" || "all")',
    );
    const peek = mfa.querySelector('.keyline .peek') as HTMLElement;
    expect(peek.querySelector('label')?.textContent).toBe('MFA_ENFORCEMENT');
    expect(peek.querySelector('.envname')?.textContent).toBe('Prod');
    expect(peek.querySelector('.is')?.textContent).toBe('admins');
    expect(mfa.textContent).not.toMatch(/In other environments/);
  });
});

describe('a sync confirmation uses link actions on the title row', () => {
  const previewEntry = {
    actor: 'ops@anudeep.pro',
    path: 'config/iam/dev.yaml',
    keys: ['SESSION_TTL'],
    revision: '1',
    timestamp: '2026-09-11T00:00:00.000Z',
  };

  it('styles Confirm and Cancel as linkbtns on the right of the heading', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [previewEntry],
        unpushed: [{ subject: 'sync iam' }],
      }),
    );
    const card = document.querySelector('#sync-card') as HTMLElement;
    const actions = card.querySelector('.titlerow .actions-right') as HTMLElement;
    const confirm = actions.querySelector('button');
    const cancel = actions.querySelector('a');

    expect(confirm?.classList.contains('linkbtn')).toBe(true);
    expect(confirm?.getAttribute('name')).toBe('confirm');
    expect(cancel?.classList.contains('linkbtn')).toBe(true);
    expect(cancel?.classList.contains('no')).toBe(true);
    expect(document.querySelector('#sync-card .searchrow')).toBeNull();
    expect(document.querySelector('#sync-card .noticerow')).toBeNull();
  });

  it('groups unsynced writes and unpushed commits separately', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [previewEntry],
        unpushed: [{ subject: 'sync iam' }],
      }),
    );
    const groups = [...document.querySelectorAll('#sync-card .sync-group')].map((group) => ({
      label: group.querySelector('.facts')?.textContent?.trim(),
      body: group.textContent,
    }));
    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).toBe('Unsynced writes');
    expect(groups[0]?.body).toContain('Iam');
    expect(groups[0]?.body).toContain('Dev');
    expect(groups[0]?.body).toContain('SESSION_TTL');
    expect(groups[0]?.body).not.toContain('ops@anudeep.pro');
    expect(groups[1]?.label).toBe('Not yet pushed');
    expect(groups[1]?.body).toContain('sync iam');
    expect(document.querySelector('#sync-card .facts')?.textContent).toMatch(/2 actions to sync/);
  });

  it('opens a changelog with time and before/after on hover of a write', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [previewEntry],
        unpushed: [],
        changesByPath: {
          'config/iam/dev.yaml': [{ key: 'SESSION_TTL', from: 30, to: 60 }],
        },
      }),
    );
    const set = document.querySelector('#sync-card .sync-set') as HTMLElement;
    const heading = set.querySelector('.sync-heading') as HTMLElement;
    expect(heading.getAttribute('tabindex')).toBe('0');
    expect(heading.querySelector('.sync-product')?.textContent).toBe('Iam');
    expect(set.querySelector('.sync-env-name')?.textContent).toBe('Dev');
    const row = set.querySelector('.sync-vars .wasnow') as HTMLElement;
    expect(row.querySelector('.diffkey')?.textContent).toBe('SESSION_TTL');
    expect(row.querySelector('.was')?.textContent).toBe('30');
    expect(row.querySelector('.is')?.textContent).toBe('60');
    expect(heading.querySelector('.detail h3')?.textContent).toBe('Changelog');
    expect(heading.querySelector('.detail .sync-env-name')?.textContent).toBe('Dev');
    expect(heading.querySelector('.detail .hint')?.textContent).toBe('11 Sep 2026, 00:00 UTC');
    expect(set.querySelectorAll(':scope > .sync-tree .sync-vars .wasnow')).toHaveLength(1);
  });

  it('lists every changed key under its product/environment', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [
          previewEntry,
          {
            ...previewEntry,
            path: 'config/iam/prod.yaml',
            keys: ['MFA_ENFORCEMENT'],
          },
        ],
        unpushed: [],
        changesByPath: {
          'config/iam/dev.yaml': [{ key: 'SESSION_TTL', from: 30, to: 60 }],
          'config/iam/prod.yaml': [
            { key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all' },
            { key: 'SESSION_TTL', from: 30, to: 90 },
          ],
        },
      }),
    );
    const set = document.querySelector('#sync-card .sync-set') as HTMLElement;
    expect(set.querySelector('.sync-product')?.textContent).toBe('Iam');
    const listed = [...set.querySelectorAll(':scope > .sync-tree > li')].map((node) => ({
      environment: node.querySelector('.sync-env-name')?.textContent,
      keys: [...node.querySelectorAll('.sync-vars .diffkey')].map((key) => key.textContent),
      values: [...node.querySelectorAll('.sync-vars .wasnow')].map((row) => ({
        from: row.querySelector('.was')?.textContent,
        to: row.querySelector('.is')?.textContent,
      })),
    }));
    expect(listed).toEqual([
      {
        environment: 'Dev',
        keys: ['SESSION_TTL'],
        values: [{ from: '30', to: '60' }],
      },
      {
        environment: 'Prod',
        keys: ['MFA_ENFORCEMENT', 'SESSION_TTL'],
        values: [
          { from: 'optional', to: 'all' },
          { from: '30', to: '90' },
        ],
      },
    ]);
    const hovered = [...set.querySelectorAll('.detail .sync-tree > li')].map((env) => ({
      name: env.querySelector('.sync-env-name')?.textContent,
      keys: [...env.querySelectorAll('.diffkey')].map((key) => key.textContent),
    }));
    expect(hovered).toEqual([
      { name: 'Dev', keys: ['SESSION_TTL'] },
      { name: 'Prod', keys: ['MFA_ENFORCEMENT', 'SESSION_TTL'] },
    ]);
  });

  it('omits a retiring product, which has its own workflow', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [
          previewEntry,
          {
            actor: 'ops@anudeep.pro',
            path: 'schema/iam.yaml',
            keys: ['retiring'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
        ],
        unpushed: [],
        changesByPath: {
          'config/iam/dev.yaml': [{ key: 'SESSION_TTL', from: 30, to: 60 }],
        },
      }),
    );
    const card = document.querySelector('#sync-card') as HTMLElement;
    expect(card.textContent).not.toMatch(/Will be retired/);
    expect(card.querySelector('.sync-retired')).toBeNull();
    expect(card.textContent).not.toContain('SESSION_TTL');
    expect(card.textContent).not.toMatch(/schema/);
    expect(card.textContent).not.toContain('retiring');
    expect(card.querySelector('.facts')?.textContent).toMatch(/0 actions to sync/);
  });

  it('nests a new product and its env vars under Registry', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [
          {
            actor: 'ops@anudeep.pro',
            path: 'services.yaml',
            keys: ['api'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
          {
            actor: 'ops@anudeep.pro',
            path: 'config/api/dev.yaml',
            keys: ['COUNT'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
          {
            actor: 'ops@anudeep.pro',
            path: 'config/api/prod.yaml',
            keys: ['COUNT'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
        ],
        unpushed: [],
        changesByPath: {
          'config/api/dev.yaml': [{ key: 'COUNT', from: undefined, to: 2 }],
          'config/api/prod.yaml': [{ key: 'COUNT', from: undefined, to: 2 }],
        },
      }),
    );
    const registry = document.querySelector('#sync-card .sync-set') as HTMLElement;
    expect(registry.querySelector('.sync-heading')?.textContent).toBe('Registry');
    expect(registry.querySelector('.sync-added')?.textContent).toContain('Api ( Added )');
    expect(
      [...registry.querySelectorAll('.sync-added .detail .sync-env-name')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['Dev', 'Prod']);
    const envs = [...registry.querySelectorAll(':scope > .sync-tree > li > .sync-tree > li')].map(
      (node) => ({
        environment: node.querySelector('.sync-env-name')?.textContent,
        key: node.querySelector('.diffkey')?.textContent,
        from: node.querySelector('.was')?.textContent,
        to: node.querySelector('.is')?.textContent,
      }),
    );
    expect(envs).toEqual([
      { environment: 'Dev', key: 'COUNT', from: '(None)', to: '2' },
      { environment: 'Prod', key: 'COUNT', from: '(None)', to: '2' },
    ]);
  });

  it('marks schema variables as added or removed, not as a value diff', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [
          {
            actor: 'ops@anudeep.pro',
            path: 'schema/iam.yaml',
            keys: ['ADAS_WE', 'ADAS_WEWE', 'DDEE__QQ', 'DDEE__QQ__QQ'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
        ],
        unpushed: [],
        changesByPath: {
          'schema/iam.yaml': [
            { key: 'ADAS_WE', from: undefined, to: true, kind: 'added' },
            { key: 'ADAS_WEWE', from: undefined, to: true, kind: 'added' },
            { key: 'DDEE__QQ', from: true, to: undefined, kind: 'removed' },
            { key: 'DDEE__QQ__QQ', from: true, to: undefined, kind: 'removed' },
          ],
        },
      }),
    );
    const set = document.querySelector('#sync-card .sync-set') as HTMLElement;
    expect(set.querySelector('.sync-product')?.textContent).toBe('Iam schema');
    const listed = [...set.querySelectorAll(':scope > .sync-tree .sync-vars .wasnow')].map(
      (row) => ({
        key: row.querySelector('.diffkey')?.textContent,
        added: row.querySelector('.sync-added')?.textContent?.replace(/\s+/g, ' ').trim(),
        removed: row.querySelector('.sync-archived')?.textContent?.replace(/\s+/g, ' ').trim(),
      }),
    );
    expect(listed).toEqual([
      { key: 'ADAS_WE', added: '( Added )', removed: undefined },
      { key: 'ADAS_WEWE', added: '( Added )', removed: undefined },
      { key: 'DDEE__QQ', added: undefined, removed: '( Removed )' },
      { key: 'DDEE__QQ__QQ', added: undefined, removed: '( Removed )' },
    ]);
  });

  it('lists an archived product under Registry', () => {
    document.body.innerHTML = String(
      renderSyncPreview({
        entries: [
          {
            actor: 'ops@anudeep.pro',
            path: 'services.yaml',
            keys: ['iam'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
          {
            actor: 'ops@anudeep.pro',
            path: 'archived/iam.yaml',
            keys: ['iam'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
          {
            actor: 'ops@anudeep.pro',
            path: 'schema/iam.yaml',
            keys: ['retiring', 'iam'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
        ],
        unpushed: [],
        retiring: ['iam'],
      }),
    );
    const card = document.querySelector('#sync-card') as HTMLElement;
    expect(card.querySelector('.sync-heading')?.textContent).toBe('Registry');
    expect(card.querySelector('.sync-archived')?.textContent).toBe('Iam ( Archived )');
    expect(card.textContent).not.toMatch(/Archived Iam/);
    expect(card.textContent).not.toMatch(/Iam schema/);
    expect(card.querySelector('.facts')?.textContent).toMatch(/1 action to sync/);
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
