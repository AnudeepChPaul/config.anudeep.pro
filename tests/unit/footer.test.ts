import { renderFeatures, renderProduct, renderProducts } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

const chrome = {
  build: '0.1.0+abc1234',
  autoSync: false,
  settingsLink: true,
};

const footerOf = (html: string): string => {
  const match = html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/);
  return match?.[0] ?? '';
};

describe('page footer', () => {
  it('is identical on unrelated pages that share the same chrome', () => {
    const products = String(renderProducts({ products: [], ...chrome, currentPath: '/' }));
    const features = String(
      renderFeatures({
        flags: {},
        environment: 'dev',
        environments: ['dev'],
        ...chrome,
        currentPath: '/features?env=dev',
      }),
    );
    const product = String(
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
        ...chrome,
        currentPath: '/p/iam?env=dev',
      }),
    );

    expect(footerOf(products)).toBe(footerOf(features));
    expect(footerOf(products)).toBe(footerOf(product));
    expect(footerOf(products)).toContain('id="pagefoot"');
    expect(footerOf(products)).not.toContain('name="next"');
  });

  it('is omitted from htmx fragments so a page swap cannot replace it', () => {
    const html = String(
      renderProducts({
        products: [{ name: 'iam', environments: ['dev'], retiring: false }],
        fragment: true,
        ...chrome,
      }),
    );

    expect(html).not.toContain('<!doctype html>');
    expect(html).not.toContain('class="pagefoot"');
    expect(html).not.toContain('id="pagefoot"');
  });

  it('is swapped out of band only when the call is footer-related', () => {
    const html = String(
      renderProducts({
        products: [],
        fragment: true,
        updateFooter: true,
        ...chrome,
      }),
    );

    expect(html).not.toContain('<!doctype html>');
    expect(html).toContain('id="pagefoot"');
    expect(html).toContain('hx-swap-oob="true"');
  });
});
