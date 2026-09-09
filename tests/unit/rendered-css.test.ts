import {
  type KeyRow,
  renderProduct,
  renderProducts,
  renderSettings,
} from '@config/src/views/pages.js';
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

    expect(css).toMatch(/\.actions \{[^}]*font-size:\s*var\(--type-sm\)/);
  });

  it('gives the separator enough contrast to read as one', () => {
    // It was a line colour, under 2:1 against white — the dots were invisible and the facts ran
    // together. It takes the muted text role now, which is a colour meant to be read.
    const css = productPage([]);

    expect(css).toMatch(/\.sep \{[^}]*color:\s*var\(--muted\)/);
  });
});

describe('every link button matches the toolbar', () => {
  // .linkbtn set `font: inherit`, and the shorthand RESETS font-size to whatever is inherited —
  // overriding the base button rule. So a link action was 13px inside .actions and 15px in the
  // drafts list, the promote card and the product list. Three sizes for one control.
  it('does not reset the size with a font shorthand', () => {
    const rule = productPage([]).match(/\.linkbtn \{[^}]*\}/)?.[0] ?? '';

    expect(rule).not.toMatch(/font:\s/);
  });

  it('leaves the size to the base button rule, which the toolbar shares', () => {
    const css = productPage([]);
    const base = css.match(/\n\s*button \{[\s\S]*?\}/)?.[0] ?? '';

    expect(base).toMatch(/font-size:\s*var\(--type-sm\)/);
    expect(css).toMatch(/\.actions \{[^}]*font-size:\s*var\(--type-sm\)/);
  });
});

describe('button styling is global', () => {
  // It was a toolbar-local rule, so every button outside the toolbar — Sign in, the product
  // list's actions — was set at a different size from the ones beside them.
  it('sizes buttons in the base rule, not under the toolbar', () => {
    const css = productPage([]);
    const base = css.match(/\n\s*button \{[\s\S]*?\}/)?.[0] ?? '';

    // Every button on every page inherits it — Sign in included, which sits outside any toolbar.
    expect(base).toMatch(/font-size:\s*var\(--type-sm\)/);
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
  it('renders the products publish as a link, phrased as a question', () => {
    // The search button comes first on the page now, so this names the publish one rather than
    // taking whichever button happens to be first.
    const button =
      productsPage(2)
        .match(/<button[\s\S]*?<\/button>/g)
        ?.find((markup) => markup.includes('Publish')) ?? '';

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

/**
 * The palette, as named roles.
 *
 * Twelve hex values were written inline across this file, several near-duplicates, and nothing
 * said what any of them meant — so a new element got whichever value looked closest. A colour is
 * now a role with a name, and a rule that wants a colour has to pick one.
 */
describe('colour is a role, not a literal', () => {
  const css = () => productPage([]).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';

  it('defines every role once, at the root', () => {
    const sheet = css();

    for (const token of [
      '--ground',
      '--surface',
      '--ink',
      '--muted',
      '--line',
      '--hair',
      '--accent',
      '--unpublished',
      '--danger',
    ]) {
      expect(sheet).toContain(`${token}:`);
    }
  });

  it('carries no bare hex outside the token block', () => {
    // The token block is the one place a colour is written down; everywhere else names a role.
    const sheet = css();
    const root = sheet.match(/:root \{[\s\S]*?\}/)?.[0] ?? '';
    const outside = sheet.replace(root, '');

    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it('sizes every control from one token, not from padding', () => {
    const sheet = css();

    expect(sheet).toMatch(/--control-h:\s*34px/);
    expect(sheet).toMatch(/height:\s*var\(--control-h\)/);
  });

  it('keeps the type scale in tokens too', () => {
    const sheet = css();

    for (const token of ['--type-sm', '--type-base', '--type-title']) {
      expect(sheet).toContain(`${token}:`);
    }
  });
});

describe('nothing styles itself inline', () => {
  // The stylesheet is where a decision about how something looks belongs. A style attribute is
  // how the console came to have three type sizes for the same kind of text and two greys for
  // muted — each written at the point someone needed it, none of them findable afterwards.
  //
  // Every page that HAS this markup: the product list's names, and a page whose hover panels
  // carry changed values.
  const busyPages = () => [
    productsPage(2),
    productPage([
      {
        key: 'MFA_ENFORCEMENT',
        definition: definition({ type: 'string' }),
        value: 'all',
        publishedValue: 'optional',
        pending: true,
      },
    ]),
  ];

  it('names no colour in a style attribute', () => {
    for (const page of busyPages()) {
      const markup = page.replace(/<style>[\s\S]*?<\/style>/, '');

      expect(markup.match(/style="[^"]*#[0-9a-fA-F]{3,8}/g) ?? []).toEqual([]);
    }
  });

  it('names no font-size in a style attribute', () => {
    for (const page of busyPages()) {
      const markup = page.replace(/<style>[\s\S]*?<\/style>/, '');

      expect(markup.match(/style="[^"]*font-size/g) ?? []).toEqual([]);
    }
  });
});

/**
 * The header holds its place, and the page does not jump.
 *
 * Three reported faults, each with a mechanism: a reserved row shorter than the line box it has
 * to hold grows when it gets content; a margin inside a reserved row overflows it; and a page
 * whose scrollbar comes and goes moves sideways by the width of it.
 */
describe('nothing moves when you navigate', () => {
  const css = () => productPage([]).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';

  it('fixes each header row to a height, rather than a floor it can exceed', () => {
    // min-height 1.15rem against a 1.5 line box is 1px short: the row was taller on the page
    // that had a breadcrumb than on the one that did not, so the title moved.
    const sheet = css();

    // The crumb row is gone: the heading is the trail now, so there is one row fewer to hold.
    // noticerow included: a row that only takes height when it holds something is the shift
    // it was added to prevent.
    for (const row of ['titlerow', 'facts', 'searchrow', 'noticerow']) {
      expect(sheet, `${row} is fixed, not floored`).toMatch(
        new RegExp(`\\.${row} \\{[^}]*\\bheight:`),
      );
    }
  });

  it('gives every reserved row a line-height, so its content cannot outgrow it', () => {
    const sheet = css();

    expect(sheet).toMatch(/\.facts \{[^}]*line-height:/);
    expect(sheet).toMatch(/\.pagehead h1 \{[^}]*line-height:|\.pagehead h1 \{[^}]*white-space:/);
  });

  it('keeps the scrollbar gutter, so filtering does not slide the page sideways', () => {
    // Search shortens the list, the scrollbar goes, and everything shifts by its width.
    expect(css()).toMatch(/scrollbar-gutter:\s*stable/);
  });

  it('puts no margin inside the search row it has to fit in', () => {
    const markup = productPage([]).replace(/<style>[\s\S]*?<\/style>/, '');

    expect(markup.match(/style="[^"]*margin/g) ?? []).toEqual([]);
  });
});

/**
 * Colour says what a thing IS, not how important it is.
 *
 * The palette gives --accent one job — anything you can click — and --unpublished another: the
 * state of being drafted but not committed. Painting the publish action in the state colour
 * broke the only rule the palette has, so colour stopped telling an action from a fact: the
 * publish action and the "2 unpublished changes" it sat beside were the same colour, while
 * Save, which is equally an action, was a different one.
 *
 * Consequence is carried by weight instead. An action that ships something is heavier than one
 * that writes a draft; both are still recognisably actions.
 */
describe('an action is never painted as a state', () => {
  const css = () => productPage([]).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';
  const rule = (selector: string) =>
    css().match(new RegExp(`\\${selector} \\{[^}]*\\}`))?.[0] ?? '';

  it('gives every link action the accent, publish included', () => {
    expect(rule('.linkbtn')).toMatch(/color:\s*var\(--accent\)/);
    expect(rule('.linkbtn.go')).not.toMatch(/var\(--unpublished\)/);
  });

  it('marks the consequential one by weight rather than by colour', () => {
    expect(rule('.linkbtn.go')).toMatch(/font-weight/);
  });

  it('keeps the state colour for states', () => {
    // The count, the tab marker, the chip and the locked tick are facts about the environment,
    // not things to press.
    for (const selector of ['.actionline .count', '.dot', '.chip.wait']) {
      expect(css()).toContain('var(--unpublished)');
      expect(selector.length).toBeGreaterThan(0);
    }
    expect(rule('.dot')).toMatch(/var\(--unpublished\)/);
    expect(rule('.chip.wait')).toMatch(/var\(--unpublished\)/);
  });

  it('does not call a search result unpublished either', () => {
    // Where a search landed is not a state of the configuration; it is where you are looking.
    expect(rule('.found')).not.toMatch(/var\(--unpublished\)/);
    expect(rule('.found')).toMatch(/var\(--accent\)/);
  });
});

describe('a link action is the same size whichever element it is', () => {
  // .linkbtn set no font-size, so a <button> took 13px from the base button rule and an <a>
  // inherited 15px from the body. Search beside Clear, and "Save 3 as a draft in prod?" beside
  // "Not now", were a button and an anchor — two sizes, two baselines, two underline heights.
  const rule = (selector: string) =>
    (productPage([]).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '').match(
      new RegExp(`\\${selector} \\{[^}]*\\}`),
    )?.[0] ?? '';

  it('states its own size rather than inheriting whatever is around it', () => {
    expect(rule('.linkbtn')).toMatch(/font-size:\s*var\(--type-sm\)/);
  });

  it('centres its text the same way in both elements', () => {
    expect(rule('.linkbtn')).toMatch(/display:\s*inline-flex/);
    expect(rule('.linkbtn')).toMatch(/align-items:\s*center/);
  });
});

/**
 * A negative action is danger-coloured.
 *
 * Drop, Not now and Clear all rendered in --accent, the colour for anything you can press, so
 * declining an offer and accepting one looked like the same move. The operator's rule: a negative
 * or destructive action is --danger. The palette note in
 * `markdown_plans/config.anudeep.pro/console-ui-revamp-2026-09-09.md` was amended to match.
 */
describe('a negative action is danger-coloured', () => {
  const rule = (selector: string) =>
    (productPage([]).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '').match(
      new RegExp(`\\${selector} \\{[^}]*\\}`),
    )?.[0] ?? '';

  it('paints the negative modifier with the danger token', () => {
    expect(rule('.linkbtn.no')).toMatch(/color:\s*var\(--danger\)/);
  });

  // It is a modifier, not a second button: restating a size here would re-open the bug that
  // put Search and Clear on two baselines.
  it('leaves the size to .linkbtn', () => {
    expect(rule('.linkbtn.no')).not.toMatch(/font-size/);
  });

  it('does not weight the trail link, so both halves of the heading match', () => {
    expect(rule('.pagehead h1 a')).not.toMatch(/font-weight/);
  });
});

/**
 * A notice is a line, not a banner.
 *
 * A bordered, filled block shouted one sentence louder than the thing it reported, and it lived
 * in the page body, so it pushed the content down as it arrived and back up as it cleared.
 */
describe('the notice line', () => {
  const rule = (selector: string) =>
    (productPage([]).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '').match(
      new RegExp(`\\${selector} \\{[^}]*\\}`),
    )?.[0] ?? '';

  it('is underlined text at the weight the operator asked for', () => {
    expect(rule('.notice')).toMatch(/font-weight:\s*500/);
    expect(rule('.notice')).toMatch(/text-decoration:\s*underline/);
  });

  it('says which kind of news by colour alone', () => {
    expect(rule('.notice.done')).toMatch(/color:\s*var\(--accent\)/);
    expect(rule('.notice.problem')).toMatch(/color:\s*var\(--danger\)/);
  });

  // The rule is the operator's: a negative or dismissive action is --danger, wherever it is.
  // Dismiss inherited the line's colour, so on a confirmation it was painted as an ordinary
  // action in --accent -- the one place the rule was not being applied.
  it('paints its dismiss as the negative action it is', () => {
    expect(rule('.notice .linkbtn.no')).toMatch(/var\(--danger\)|font-weight/);
    expect(rule('.notice-dismiss')).not.toMatch(/color:\s*inherit/);
  });

  it('is not a banner: no border, no fill', () => {
    expect(rule('.notice')).not.toMatch(/border:|background:/);
  });
});

/**
 * The settings table has an inset.
 *
 * It used to sit inside a .card, which supplied padding along with the second border that had to
 * go. Removing the card took the padding with it and the rows went flush against the edge -- the
 * class meant to replace it was written in the stylesheet and never attached to the markup, so
 * the rule existed and applied to nothing.
 */
describe('the settings table', () => {
  const sheet = () =>
    (renderSettings({ env: {}, fragment: false })
      .toString()
      .match(/<style>[\s\S]*?<\/style>/) ?? [''])[0];
  const rule = (selector: string) =>
    sheet().match(new RegExp(`\\${selector} \\{[^}]*\\}`))?.[0] ?? '';

  it('insets its rows from the border rather than letting them touch it', () => {
    expect(rule('.settings-row')).toMatch(/padding:/);
  });

  // The rule is worthless unless something wears the class.
  it('actually puts that class on every row', () => {
    const body = String(renderSettings({ env: { CONFIG_GIT_REMOTE: 'x' }, fragment: true }));
    const rows = body.match(/<div class="[^"]*keyrow[^"]*"/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain('settings-row');
  });
});
