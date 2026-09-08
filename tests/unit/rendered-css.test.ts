import { type KeyRow, renderProduct, renderProducts } from '@config/src/views/pages.js';
import { describe, expect, it } from 'vitest';

/**
 * Two defects that were visible on the page and invisible to every other test.
 *
 * Both live in CSS, and neither shows up in markup assertions or in a request/response test:
 * one clipped a panel that was present in the HTML, the other left a control that toggled its
 * checkbox while nothing moved on screen.
 *
 * These assert the MECHANISM — the rules that make the behaviour possible. They cannot prove
 * the page looks right; only that the thing whose absence caused each bug is still there.
 */

const definition = (over: Record<string, unknown> = {}) =>
  ({ type: 'bool', secret: false, ...over }) as unknown as KeyRow['definition'];

const productPage = (rows: KeyRow[]) =>
  String(
    renderProduct({
      service: 'iam',
      environments: [{ name: 'dev', namespace: 'iam/dev', pending: [] }],
      active: 'dev',
      rows,
      commit: 'a'.repeat(40),
    }),
  );

describe('the hover panel is not clipped by its container', () => {
  // The panel sits inside a row, and the row list is a rounded card. Rounding it with
  // `overflow: hidden` also cuts off anything absolutely positioned inside — the detail
  // appeared, then stopped at the card's edge.
  const listOverflow = (page: string) => page.match(/\.rows\s*\{[^}]*\}/)?.[0] ?? '';

  it('does not hide overflow on the row list', () => {
    const page = String(renderProducts({ products: [], commit: 'a'.repeat(40) }));

    expect(listOverflow(page)).not.toMatch(/overflow:\s*hidden/);
  });

  it('still rounds the card, on the first and last rows instead', () => {
    const page = String(renderProducts({ products: [], commit: 'a'.repeat(40) }));

    expect(page).toContain('.rows > *:first-child');
    expect(page).toContain('.rows > *:last-child');
  });

  it('gives the panel a stacking order so a later row does not cover it', () => {
    const page = String(renderProducts({ products: [], commit: 'a'.repeat(40) }));

    expect(page).toMatch(/\.detail\s*\{[^}]*z-index/);
  });
});

describe('the switch reflects the checkbox', () => {
  // There is no script on this page, so a state the server rendered into a class cannot change
  // when someone clicks. The control toggled its hidden checkbox and looked identical, which
  // reads as "the switch does not work".
  const page = () =>
    productPage([
      {
        key: 'KILL_PASSWORD_LOGIN',
        definition: definition(),
        value: false,
        publishedValue: false,
        pending: false,
      },
    ]);

  it('styles the track from :checked rather than a server-rendered class', () => {
    const body = page();

    expect(body).toMatch(/\.switch input:checked ~ \.track\s*\{/);
    expect(body).not.toMatch(/\.track\.on\s*\{/);
  });

  it('moves the knob from :checked too', () => {
    expect(page()).toMatch(/\.switch input:checked ~ \.track \.knob\s*\{/);
  });

  it('generates the word beside it rather than rendering it once', () => {
    const body = page();

    expect(body).toMatch(/\.switch \.state::after\s*\{\s*content: 'false'/);
    expect(body).toMatch(/\.switch input:checked ~ \.state::after\s*\{\s*content: 'true'/);
    // Nothing static to contradict the live state.
    expect(body).toContain('<span class="state"></span>');
  });

  it('keeps the checkbox inside the label, so the whole control is the hit area', () => {
    const body = page();
    const label = body.match(/<label class="switch">[\s\S]*?<\/label>/)?.[0] ?? '';

    expect(label).toMatch(/<input type="checkbox"/);
    expect(label).toMatch(/<span class="track">/);
  });

  it('shows the switch as on when the value is true', () => {
    const body = productPage([
      {
        key: 'KILL_PASSWORD_LOGIN',
        definition: definition(),
        value: true,
        publishedValue: true,
        pending: false,
      },
    ]);

    // Not anchored to attribute order: `checked` may sit anywhere in the tag, and pinning it
    // to the end broke the moment another attribute was added after it.
    const input =
      body.match(/<input type="checkbox"[^>]*name="key.KILL_PASSWORD_LOGIN"[^>]*>/s)?.[0] ?? '';
    expect(input).toContain('checked');
  });

  it('keeps focus visible, since the real checkbox is hidden', () => {
    // Hiding the input to draw a switch removes the browser's own focus ring; without a
    // replacement the control is invisible to keyboard users.
    expect(page()).toMatch(/\.switch input:focus-visible ~ \.track/);
  });
});

describe('a hidden element is actually hidden', () => {
  // `hidden` is a UA style of `display: none`, and ANY author rule setting display beats it —
  // so `.selection { display: inline-flex }` left the selection count on screen on a clean
  // slate, reading "0 of 4 unpublished changes" beside the idle line. Every element the script
  // hides is display-typed like this, which makes the override the mechanism, not a nicety.
  it('overrides display for [hidden], which every author display rule otherwise wins against', () => {
    const css = productPage([]);

    expect(css).toMatch(/\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/);
  });

  it('sets display on the elements the script hides, which is why it is needed', () => {
    const css = productPage([]);

    expect(css).toMatch(/\.selection \{[^}]*display:/);
  });
});
