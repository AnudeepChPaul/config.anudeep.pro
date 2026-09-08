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

describe('the toolbar reads as one line', () => {
  it('sizes its text to match the buttons in it', () => {
    // A link-styled action set a step larger than the sentence it belongs to reads as a button
    // pretending to be a word. The actions themselves are sized by the global button rule.
    const css = productPage([]);

    expect(css).toMatch(/\.actions \{[^}]*font-size:\s*\.8125rem/);
  });

  it('gives the separator enough contrast to read as one', () => {
    // #cbd0d9 against #fff is under 2:1 — the dots were invisible, so the facts ran together.
    const css = productPage([]);

    expect(css).toMatch(/\.sep \{[^}]*color:\s*#(?!cbd0d9)[0-9a-f]{6}/);
  });
});

describe('button styling is global', () => {
  // It was a toolbar-local rule, so every button outside the toolbar — Sign in, the product
  // list's actions — was set at a different size from the ones beside them.
  it('sizes buttons in the base rule, not under the toolbar', () => {
    const css = productPage([]);
    const base = css.match(/\n\s*button \{[\s\S]*?\}/)?.[0] ?? '';

    // Every button on every page inherits it — Sign in included, which sits outside any toolbar.
    expect(base).toMatch(/font-size:\s*\.8125rem/);
    expect(css).not.toMatch(/\.actionline button[^{]*\{/);
  });
});

describe('a write in flight says so', () => {
  // A publish runs sops, git commit and git push over SSH — up to seconds, unbounded on a bad
  // network. htmx swaps nothing until it returns, so without this the page is unchanged and the
  // action looks unpressed.
  const css = () => productPage([]);

  it('keys the running state on the class htmx sets for the duration of a request', () => {
    expect(css()).toMatch(/\.htmx-request/);
  });

  it('hides the resting label and shows the running one, and never both', () => {
    const sheet = css();

    expect(sheet).toMatch(/\.running \{[^}]*display:\s*none/);
    expect(sheet).toMatch(/\.htmx-request .resting \{[^}]*display:\s*none/);
    expect(sheet).toMatch(/\.htmx-request .running \{[^}]*display:\s*inline/);
  });

  it('animates the spinner, so a slow push does not look like a frozen page', () => {
    const sheet = css();

    expect(sheet).toMatch(/@keyframes/);
    expect(sheet).toMatch(/animation:/);
  });

  it('gives every write action a resting and a running label', () => {
    const busy = String(
      renderProduct({
        service: 'iam',
        environments: [
          {
            name: 'dev',
            namespace: 'iam/dev',
            pending: [{ key: 'A', from: '1', to: '2', secret: false }],
          },
        ],
        active: 'dev',
        rows: [],
        commit: 'a'.repeat(40),
      }),
    );

    for (const button of busy.match(/<button[\s\S]*?<\/button>/g) ?? []) {
      expect(button).toContain('class="resting"');
      expect(button).toContain('class="running"');
    }
  });
});

describe('every publish action reads the same way', () => {
  // One idiom across the console: a link-styled question in the environment's own colour, and
  // absent rather than greyed when there is nothing behind it.
  const productsPage = (pending: number) =>
    String(
      renderProducts({
        commit: 'a'.repeat(40),
        products: [
          {
            name: 'iam (1002)',
            service: 'iam',
            keys: '4 keys',
            environments: [
              {
                name: 'dev',
                namespace: 'iam/dev',
                drafts: pending,
                pending: Array.from({ length: pending }, (_, i) => ({
                  key: `K${i}`,
                  from: 'a',
                  to: 'b',
                  secret: false,
                })),
              },
            ],
          },
        ],
      }),
    );

  it('renders the products publish as a link, phrased as a question', () => {
    const button = productsPage(2).match(/<button[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

    expect(button).toContain('linkbtn');
    expect(button).toContain('go');
    expect(button).toMatch(/\?/);
  });

  it('offers no products publish at all when nothing is waiting', () => {
    // The search button remains: it changes nothing, so it is not a publish action.
    expect(productsPage(0)).not.toContain('value="publish"');
    expect(productsPage(0)).not.toContain('Publish selected');
  });

  it('renders the whole-product publish as a link, and not at all when idle', () => {
    const busy = String(
      renderProduct({
        service: 'iam',
        environments: [
          {
            name: 'dev',
            namespace: 'iam/dev',
            drafts: 1,
            pending: [{ key: 'A', from: '1', to: '2', secret: false }],
          },
        ],
        active: 'dev',
        rows: [],
        commit: 'a'.repeat(40),
      }),
    );

    expect(busy).toMatch(/<button[^>]*class="linkbtn go"[\s\S]*?Publish all 1 draft in iam\?/);
    expect(productPage([])).not.toContain('Publish all');
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
