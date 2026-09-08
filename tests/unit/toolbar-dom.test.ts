// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type KeyRow, renderProduct } from '@config/src/views/pages.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The script against the page it actually runs on.
 *
 * ticks.test.ts drives it against hand-written markup, which proves the logic and nothing about
 * whether the real page matches the shape the logic expects — a class it does not expect, an
 * element nested one level deeper, and the script silently does nothing. This renders the
 * console's own markup and runs the script on that.
 */
const source = readFileSync(join(process.cwd(), 'src/views/assets/ticks.js'), 'utf8');

const definition = (over: Record<string, unknown> = {}) =>
  ({ type: 'string', secret: false, ...over }) as unknown as KeyRow['definition'];

const rows: KeyRow[] = [
  { key: 'MFA_ENFORCEMENT', definition: definition(), value: 'optional' },
  { key: 'SESSION_TTL', definition: definition({ type: 'int' }), value: 900 },
];

const render = (over: Partial<Parameters<typeof renderProduct>[0]> = {}) =>
  String(
    renderProduct({
      service: 'iam',
      environments: [{ name: 'dev', namespace: 'iam/dev', pending: [] }],
      active: 'dev',
      rows,
      commit: 'a'.repeat(40),
      ...over,
    }),
  );

const tick = (key: string) =>
  document.querySelector<HTMLInputElement>(`input[data-select="${key}"]`) as HTMLInputElement;
const selection = () => document.querySelector('[data-selection]') as HTMLElement;
const idle = () => document.querySelector('.idle') as HTMLElement;
const count = () => document.querySelector('.count') as HTMLElement;
const save = () => document.querySelector('button[value="save"]') as HTMLButtonElement | null;
/** Shown or not: the action is hidden rather than removed, so the script can bring it back. */
const draftOffered = () =>
  [...document.querySelectorAll('[data-draft-action]')].every((el) => !(el as HTMLElement).hidden);

const load = (html: string) => {
  document.body.innerHTML = `<div id="page">${html}</div>`;
  new Function(source)();
};

/** What htmx does to this page: replaces #page's contents, in place, with a new render. */
const swap = (html: string) => {
  const page = document.querySelector('#page') as HTMLElement;
  page.innerHTML = html;
  page.dispatchEvent(new Event('htmx:afterSwap', { bubbles: true }));
};

beforeEach(() => load(render()));

const drafted = (keys: string[]) =>
  render({
    drafted: keys,
    rows: rows.map((row) => (keys.includes(row.key) ? { ...row, pending: true } : row)),
    environments: [
      {
        name: 'dev',
        namespace: 'iam/dev',
        pending: keys.map((key) => ({ key, from: 'optional', to: 'all', secret: false })),
      },
    ],
  });

describe('the two kinds of change have two names', () => {
  // Edited on the page and not yet saved is UNSAVED. Written into a draft and not yet committed
  // is UNPUBLISHED. They differ in where they live, whether they survive a reload, and which
  // action leaves them, so one word for both is wrong in one of the two states.
  it('calls a page-local edit unsaved', () => {
    const field = document.querySelector<HTMLInputElement>(
      'input[data-key="MFA_ENFORCEMENT"]',
    ) as HTMLInputElement;
    field.value = 'all';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    expect(count().textContent).toBe('1 unsaved change.');
  });

  it('calls a drafted change unpublished', () => {
    load(drafted(['MFA_ENFORCEMENT']));

    expect(count().textContent).toBe('1 unpublished change.');
  });
});

const publish = () => document.querySelector('button[value="publish"]') as HTMLButtonElement | null;
const publishOffered = () =>
  [...document.querySelectorAll('[data-publish-action]')].every(
    (el) => !(el as HTMLElement).hidden,
  );

describe('unsaved changes outrank a draft', () => {
  // Two states competing for one toolbar. Offering a publish beside unsaved edits invites
  // publishing a draft that does not include what is on the screen.
  beforeEach(() => load(drafted(['MFA_ENFORCEMENT'])));

  it('offers the publish while the page holds nothing unsaved', () => {
    expect(publish()).not.toBeNull();
    expect(publishOffered()).toBe(true);
  });

  it('withdraws it the moment a value is edited', () => {
    const field = document.querySelector<HTMLInputElement>(
      'input[data-key="SESSION_TTL"]',
    ) as HTMLInputElement;
    field.value = '1200';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    expect(publishOffered()).toBe(false);
    expect(draftOffered()).toBe(true);
  });

  it('withdraws it when a key the draft does not hold is ticked', () => {
    tick('SESSION_TTL').checked = true;
    tick('SESSION_TTL').dispatchEvent(new Event('change', { bubbles: true }));

    expect(publishOffered()).toBe(false);
  });

  it('brings it back when the page matches the draft again', () => {
    const field = document.querySelector<HTMLInputElement>(
      'input[data-key="SESSION_TTL"]',
    ) as HTMLInputElement;
    field.value = '1200';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.value = '900';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    expect(publishOffered()).toBe(true);
    expect(draftOffered()).toBe(false);
  });
});

describe('a page whose draft already holds everything ticked', () => {
  // Pressing Draft again would write the same document a second time and count a revision for
  // it, so the action is gone until something moves.
  beforeEach(() => load(drafted(['MFA_ENFORCEMENT'])));

  it('offers no draft action', () => {
    expect(draftOffered()).toBe(false);
  });

  it('brings it back when a value is edited', () => {
    const field = document.querySelector<HTMLInputElement>(
      'input[data-key="SESSION_TTL"], select[data-key="SESSION_TTL"]',
    ) as HTMLInputElement;
    field.value = '1200';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    expect(draftOffered()).toBe(true);
    expect(save()?.disabled).toBe(false);
  });

  it('brings it back when another key is ticked', () => {
    tick('SESSION_TTL').checked = true;
    tick('SESSION_TTL').dispatchEvent(new Event('change', { bubbles: true }));

    expect(draftOffered()).toBe(true);
  });

  it('takes it away again when that tick is cleared', () => {
    tick('SESSION_TTL').checked = true;
    tick('SESSION_TTL').dispatchEvent(new Event('change', { bubbles: true }));
    tick('SESSION_TTL').checked = false;
    tick('SESSION_TTL').dispatchEvent(new Event('change', { bubbles: true }));

    expect(draftOffered()).toBe(false);
  });

  it('takes it away when a drafted key is unticked, which is a change to the draft', () => {
    // Unticking a drafted key narrows what a publish would ship; it does not create something
    // new to write down.
    tick('MFA_ENFORCEMENT').checked = false;
    tick('MFA_ENFORCEMENT').dispatchEvent(new Event('change', { bubbles: true }));

    expect(draftOffered()).toBe(false);
  });
});

describe('a freshly loaded environment', () => {
  it('selects the key when its tick is clicked', () => {
    // Reported from the running console: ticking a variable on a first load did nothing.
    tick('MFA_ENFORCEMENT').checked = true;
    tick('MFA_ENFORCEMENT').dispatchEvent(new Event('change', { bubbles: true }));

    expect(count().textContent).toBe('1 unsaved change.');
    expect(selection().hidden).toBe(false);
    expect(idle().hidden).toBe(true);
    expect(save()?.disabled).toBe(false);
  });

  it('selects the key when its value is edited', () => {
    const field = document.querySelector<HTMLInputElement>(
      'input[data-key="MFA_ENFORCEMENT"]',
    ) as HTMLInputElement;
    field.value = 'all';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    expect(tick('MFA_ENFORCEMENT').checked).toBe(true);
    expect(count().textContent).toBe('1 unsaved change.');
  });

  it('still selects after an htmx swap, which replaces the form the script found', () => {
    // Every tab is an hx-get and every save is an hx-post, so the form the script bound its
    // listeners to is thrown away and replaced on the first navigation. Reported as "I loaded
    // dev or prod, ticked a variable, and nothing was selected".
    swap(render({ active: 'prod' }));

    tick('MFA_ENFORCEMENT').checked = true;
    tick('MFA_ENFORCEMENT').dispatchEvent(new Event('change', { bubbles: true }));

    expect(count().textContent).toBe('1 unsaved change.');
    expect(selection().hidden).toBe(false);
  });

  it('recounts the swapped-in page immediately, without waiting for a click', () => {
    // A page swapped in with a draft already on it must show the draft's state, not the state
    // the previous page was left in.
    swap(drafted(['MFA_ENFORCEMENT']));

    expect(count().textContent).toBe('1 unpublished change.');
  });

  it('finds the form at all, which is the failure that looks like nothing happening', () => {
    expect(document.querySelector('form[data-keys]')).not.toBeNull();
    expect(document.querySelector('[data-selection] [data-detail]')).not.toBeNull();
  });
});
