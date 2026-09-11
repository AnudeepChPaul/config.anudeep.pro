import { renderProducts } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

describe('the retiring link', () => {
  const link = (retiring: number) => {
    const html = String(renderProducts({ products: [], retiring }));
    return html.match(/<a[^>]*p\/retiring[^>]*>[^<]*<\/a>/)?.[0] ?? '';
  };

  it('is danger-coloured, like every other negative action', () => {
    expect(link(1)).toContain('class="linkbtn no"');
  });

  it('reads as the operator asked, singular and plural', () => {
    expect(link(1)).toContain('1 product retiring');
    expect(link(3)).toContain('3 products retiring');
  });

  it('is absent when nothing is retiring', () => {
    expect(link(0)).toBe('');
  });
});
