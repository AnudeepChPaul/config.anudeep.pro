// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The tick script runs in a browser and nowhere else, so asserting on its source text — which
 * is all the route tests can do — proves only that a string is present. These drive the real
 * DOM: build the markup the page renders, run the script against it, and act on it.
 */
// Not `import.meta.url`: under the jsdom environment that is an http URL, not a file one.
const source = readFileSync(join(process.cwd(), 'src/views/assets/ticks.js'), 'utf8');

const markup = `
  <form data-keys>
    <div data-actions>
      <span class="idle">12 variables in dev
        <span class="detail" data-detail><h3>Differs from prod</h3><div>UNTOUCHED</div></span>
      </span>
      <span class="selection" data-selection hidden>
        <span class="detail" data-detail><h3>Selected</h3></span>
    <input type="checkbox" name="select" value="A" data-select="A">
    <input type="text" name="key.A" value="one" data-key="A" data-original="one">
    <input type="checkbox" name="select" value="B" data-select="B">
    <input type="checkbox" name="key.B" data-key="B" data-original="false">
    <span class="pending" tabindex="0">
        <span data-label="{n} unpublished change{s}.">0 unpublished changes.</span>
      <span class="detail" data-detail><h3>Selected</h3></span>
    </span>
    <button type="submit" name="intent" value="save" data-needs-ticks data-label="Save {n}" disabled>Save 0</button>
      </span>
    </div>
  </form>
`;

const tick = (key: string) =>
  document.querySelector<HTMLInputElement>(`input[data-select="${key}"]`) as HTMLInputElement;
const field = (key: string) =>
  document.querySelector<HTMLInputElement>(`input[data-key="${key}"]`) as HTMLInputElement;
const button = () => document.querySelector('button') as HTMLButtonElement;
const sentence = () => document.querySelector('span[data-label]') as HTMLSpanElement;
const detail = () => document.querySelector('[data-selection] [data-detail]') as HTMLElement;
const driftDetail = () => document.querySelector('.idle [data-detail]') as HTMLElement;
const selection = () => document.querySelector('[data-selection]') as HTMLElement;
const idle = () => document.querySelector('.idle') as HTMLElement;

/** What a person doing it with a mouse does: the click both toggles and fires `change`. */
const clickTick = (key: string) => {
  const box = tick(key);
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
};

const type = (key: string, value: string) => {
  field(key).value = value;
  field(key).dispatchEvent(new Event('input', { bubbles: true }));
};

const run = () => {
  document.body.innerHTML = markup;
  new Function(source)();
};

beforeEach(run);

describe('ticks follow the value', () => {
  it('ticks a key once its value differs', () => {
    type('A', 'two');
    expect(tick('A').checked).toBe(true);
  });

  it('unticks it again when the value is typed back', () => {
    type('A', 'two');
    type('A', 'one');
    expect(tick('A').checked).toBe(false);
  });

  it('follows a switch, whose value is its checked state', () => {
    field('B').checked = true;
    field('B').dispatchEvent(new Event('change', { bubbles: true }));
    expect(tick('B').checked).toBe(true);
  });
});

describe('a changed value cannot be unticked', () => {
  // Publishing is per key, so an unticked-but-edited key would be written to the draft document
  // by the form post and then left out of the change set — the edit would look accepted on
  // screen and vanish. If you do not want the change, undo the change.
  it('snaps the tick back when you try to clear it', () => {
    type('A', 'two');

    clickTick('A');

    expect(tick('A').checked).toBe(true);
  });

  it('says why, rather than appearing to be a broken checkbox', () => {
    type('A', 'two');
    expect(tick('A').title).toMatch(/chang/i);
  });

  it('marks the box so it does not look like an ordinary one you may clear', () => {
    type('A', 'two');
    expect(tick('A').classList.contains('locked')).toBe(true);

    type('A', 'one');
    expect(tick('A').classList.contains('locked')).toBe(false);
  });

  it('keeps the button count right when the untick is refused', () => {
    type('A', 'two');
    clickTick('A');
    expect(button().textContent).toBe('Save 1');
  });

  it('lets go the moment the value is back to what it was', () => {
    type('A', 'two');
    type('A', 'one');

    clickTick('A');

    expect(tick('A').checked).toBe(true);
    expect(tick('A').title).toBe('');
  });
});

describe('ticks you set by hand', () => {
  it('stay where you put them on an unchanged key', () => {
    clickTick('A');
    type('B', 'x');

    expect(tick('A').checked).toBe(true);
  });

  it('can be cleared again, because nothing was changed', () => {
    clickTick('A');
    clickTick('A');
    expect(tick('A').checked).toBe(false);
  });
});

describe('the running sentence', () => {
  it('counts what is ticked, and says "change" of one', () => {
    type('A', 'two');
    expect(sentence().textContent).toBe('1 unpublished change.');
  });

  it('recounts as more are ticked', () => {
    type('A', 'two');
    clickTick('B');
    expect(sentence().textContent).toBe('2 unpublished changes.');
  });
});

describe('the toolbar itself', () => {
  // The slot's height is reserved either way, so the idle state is space already paid for: it
  // says where you are rather than sitting blank.
  it('says where you are while nothing is ticked', () => {
    expect(idle().hidden).toBe(false);
    expect(selection().hidden).toBe(true);
  });

  it('swaps to the selection the moment something is ticked', () => {
    type('A', 'two');

    expect(selection().hidden).toBe(false);
    expect(idle().hidden).toBe(true);
  });

  it('swaps back when the last tick goes', () => {
    type('A', 'two');
    type('A', 'one');

    expect(idle().hidden).toBe(false);
    expect(selection().hidden).toBe(true);
  });

  it('shows the selection with a draft and no ticks, which is still publishable', () => {
    document.body.innerHTML = markup.replace('data-actions>', 'data-actions data-has-draft>');
    new Function(source)();

    expect(selection().hidden).toBe(false);
    expect(idle().hidden).toBe(true);
  });
});

describe('the hover panel on the sentence', () => {
  // The idle line carries a panel of its own — what differs from the next environment — and it
  // renders first. Rewriting "the first panel in the form" put the selection into it and left
  // the selection's own panel showing the drift.
  it("writes into the selection's panel, not the first one on the page", () => {
    type('A', 'two');

    expect(driftDetail().textContent).toContain('UNTOUCHED');
    expect(driftDetail().textContent).not.toContain('two');
    expect(detail().textContent).toContain('two');
  });

  // The count says how many; this says which. Before a draft is saved the server has never seen
  // these edits, so the panel is built from the page itself.
  it('names each ticked key, with what it was and what it now is', () => {
    type('A', 'two');

    expect(detail().textContent).toContain('A');
    expect(detail().textContent).toContain('one');
    expect(detail().textContent).toContain('two');
  });

  it('marks a ticked key that was not edited, rather than showing a diff that is not one', () => {
    clickTick('A');

    expect(detail().textContent).toMatch(/unchanged/i);
  });

  it('drops a key from the panel when it is untickable no more', () => {
    type('A', 'two');
    type('A', 'one');

    expect(detail().textContent).not.toContain('two');
  });

  it('never prints a secret, whose value the panel has no business showing', () => {
    document.body.innerHTML = markup.replace(
      'data-select="A"',
      'data-select="A" data-secret="true"',
    );
    new Function(source)();
    type('A', 'hunter2');

    expect(detail().textContent).not.toContain('hunter2');
    expect(detail().textContent).toMatch(/hidden/i);
  });

  it('shows the published value, not the draft one, once a draft exists', () => {
    document.body.innerHTML = markup.replace(
      'data-select="A"',
      'data-select="A" data-published="zero"',
    );
    new Function(source)();
    type('A', 'two');

    // data-original is what the field was rendered with — the draft. What it is being compared
    // against for the operator is what is actually published.
    expect(detail().textContent).toContain('zero');
  });
});

describe('the buttons', () => {
  it('start disabled with nothing ticked', () => {
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Save 0');
  });

  it('enable and count once something is ticked', () => {
    type('A', 'two');
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Save 1');
  });
});
