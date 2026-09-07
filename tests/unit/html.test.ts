import { escapeHtml, html } from '@config/src/views/html.js';
import { describe, expect, it } from 'vitest';

/**
 * Escaping, tested on its own because everything the UI renders is attacker-influenced.
 *
 * Config values arrive from the repository, which is edited by people and by GitHub pushes, and
 * key names come from schema files. A value like `</textarea><script>` reaching the page
 * unescaped turns the config editor into a way to run script in an operator's session — the
 * same session that is about to be given permission to change MFA enforcement.
 */

describe('escapeHtml', () => {
  it('escapes the characters that end an element or an attribute', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a"b')).toBe('a&quot;b');
    expect(escapeHtml("a'b")).toBe('a&#39;b');
  });

  it('escapes ampersands first so escapes are not double-decoded', () => {
    // Replacing < before & would turn `&lt;` into `&amp;lt;` and display the wrong text; doing
    // it the other way round can produce a live `<` from `&amp;#60;`.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('invite_only')).toBe('invite_only');
  });

  it('handles values that are not strings', () => {
    // YAML gives us numbers, booleans and lists; none of them may reach the page unconverted.
    expect(escapeHtml(3600)).toBe('3600');
    expect(escapeHtml(true)).toBe('true');
    expect(escapeHtml(['ua', '<b>'])).toBe('[&quot;ua&quot;,&quot;&lt;b&gt;&quot;]');
  });

  it('renders null and undefined as empty rather than as the words', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('html template tag', () => {
  it('escapes interpolated values', () => {
    // The default has to be safe: a template that escapes only when remembered will eventually
    // be forgotten.
    expect(String(html`<p>${'<script>alert(1)</script>'}</p>`)).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('leaves the literal parts of the template untouched', () => {
    expect(String(html`<p class="x">${'hi'}</p>`)).toBe('<p class="x">hi</p>');
  });

  it('does not escape a fragment that was already rendered', () => {
    // Composing pages from parts must not double-escape, or nested markup arrives as text.
    const row = html`<li>${'a<b'}</li>`;

    expect(String(html`<ul>${row}</ul>`)).toBe('<ul><li>a&lt;b</li></ul>');
  });

  it('joins arrays of fragments without commas', () => {
    const rows = ['a', 'b'].map((k) => html`<li>${k}</li>`);

    expect(String(html`<ul>${rows}</ul>`)).toBe('<ul><li>a</li><li>b</li></ul>');
  });
});
