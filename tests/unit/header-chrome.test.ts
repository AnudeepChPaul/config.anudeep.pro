import { registerUiRoutes } from '@config/src/routes/ui.js';
import { consoleTabOf, shouldSwapHeader } from '@config/src/views/console-tab.js';
import { renderFeatures, renderNewProduct, renderProduct, renderProducts } from '@config/src/views/pages.js';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

const headerOf = (html: string): string => {
  const match = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/);
  return match?.[0] ?? '';
};

const dbWith = (environments: string) =>
  ({
    snapshot: async () => ({
      revision: 1,
      files: new Map([
        ['environments.yaml', environments],
        ['schema.yaml', 'version: 1\nservices: {}'],
        ['services.yaml', 'version: 1\nservices: []'],
      ]),
    }),
  }) as never;

describe('console tab of a path', () => {
  it('maps product URLs to products and feature URLs to features', () => {
    expect(consoleTabOf('/')).toBe('products');
    expect(consoleTabOf('/p/iam?env=dev')).toBe('products');
    expect(consoleTabOf('http://127.0.0.1:8200/p/new')).toBe('products');
    expect(consoleTabOf('/features')).toBe('features');
    expect(consoleTabOf('http://127.0.0.1:8200/features?env=prod')).toBe('features');
    expect(consoleTabOf('/settings')).toBeUndefined();
    expect(consoleTabOf('/sync')).toBeUndefined();
  });

  it('swaps the header only when crossing the two tabs', () => {
    expect(shouldSwapHeader('http://127.0.0.1:8200/', '/features')).toBe(true);
    expect(shouldSwapHeader('http://127.0.0.1:8200/features?env=dev', '/')).toBe(true);
    expect(shouldSwapHeader('http://127.0.0.1:8200/p/iam?env=dev', '/features')).toBe(true);
    expect(shouldSwapHeader('http://127.0.0.1:8200/', '/p/iam')).toBe(false);
    expect(shouldSwapHeader('http://127.0.0.1:8200/features?env=dev', '/features')).toBe(false);
    expect(shouldSwapHeader('http://127.0.0.1:8200/', '/settings')).toBe(false);
    expect(shouldSwapHeader(undefined, '/features')).toBe(false);
  });
});

describe('page header chrome', () => {
  it('sits outside main, with console tabs inside the header', () => {
    const html = String(
      renderProducts({
        products: [{ name: 'iam', environments: ['dev'], retiring: false }],
      }),
    );

    expect(html).toMatch(/<header\b[^>]*id="pagechrome"/);
    expect(html).toMatch(
      /<header[\s\S]*aria-label="Console sections"[\s\S]*<\/header>\s*<main id="page">/,
    );
    const header = headerOf(html);
    expect(header).toContain('aria-label="Console sections"');
    expect(header).not.toContain('class="pagehead"');
    const main = html.slice(html.indexOf('<main id="page">'), html.indexOf('</main>'));
    expect(main).not.toContain('aria-label="Console sections"');
    expect(main).toContain('class="pagehead"');
  });

  it('keeps the console tabs on Add a product, which is still the products tab', () => {
    const html = String(renderNewProduct({ environments: ['dev'] }));
    expect(headerOf(html)).toContain('id="pagechrome"');
    expect(headerOf(html)).toContain('Products');
    expect(headerOf(html)).toContain('class="tab on"');
  });

  it('is omitted from unrelated htmx fragments so a body swap cannot replace it', () => {
    const html = String(
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
        fragment: true,
      }),
    );

    expect(html).not.toContain('<!doctype html>');
    expect(html).not.toContain('id="pagechrome"');
    expect(html).not.toContain('aria-label="Console sections"');
    expect(html).toContain('class="pagehead"');
  });

  it('is swapped out of band when the call is a tab change', () => {
    const html = String(
      renderFeatures({
        flags: {},
        environment: 'dev',
        environments: ['dev'],
        fragment: true,
        updateHeader: true,
      }),
    );

    expect(headerOf(html)).toContain('id="pagechrome"');
    expect(headerOf(html)).toContain('hx-swap-oob="true"');
    expect(headerOf(html)).toContain('Features');
    expect(headerOf(html)).toContain('aria-label="Console sections"');
    expect(headerOf(html)).not.toContain('class="pagehead"');
  });
});

describe('htmx only re-renders the tab chrome when the tab changes', () => {
  const appOf = async () => {
    const app = Fastify({ logger: false });
    await app.register(formbody);
    registerUiRoutes(app, {
      db: dbWith('order: [dev]\n'),
      loader: {} as never,
      operations: {} as never,
      flagWriteService: { all: async () => ({}) } as never,
    });
    await app.ready();
    return app;
  };

  it('appends the header when going from products to features', async () => {
    const app = await appOf();
    const response = await app.inject({
      url: '/features',
      headers: {
        'hx-request': 'true',
        'hx-current-url': 'http://127.0.0.1:8200/',
      },
    });
    expect(response.body).toContain('id="pagechrome"');
    expect(response.body).toContain('hx-swap-oob="true"');
    await app.close();
  });

  it('does not append the header when staying on the products tab', async () => {
    const app = await appOf();
    const response = await app.inject({
      url: '/p/retiring',
      headers: {
        'hx-request': 'true',
        'hx-current-url': 'http://127.0.0.1:8200/',
      },
    });
    expect(response.body).not.toContain('id="pagechrome"');
    await app.close();
  });

  it('does not append the header when opening Add a product from the list', async () => {
    const app = await appOf();
    const response = await app.inject({
      url: '/p/new',
      headers: {
        'hx-request': 'true',
        'hx-current-url': 'http://127.0.0.1:8200/',
      },
    });
    expect(response.body).not.toContain('id="pagechrome"');
    expect(response.body).toContain('Add a product');
    await app.close();
  });

  it('does not append the header when staying on the features tab', async () => {
    const app = await appOf();
    const response = await app.inject({
      url: '/features?env=dev',
      headers: {
        'hx-request': 'true',
        'hx-current-url': 'http://127.0.0.1:8200/features',
      },
    });
    expect(response.body).not.toContain('id="pagechrome"');
    await app.close();
  });
});
