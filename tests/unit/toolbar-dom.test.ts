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

const load = (html: string) => {
  document.body.innerHTML = html;
  new Function(source)();
};

beforeEach(() => load(render()));

describe('a freshly loaded environment', () => {
  it('selects the key when its tick is clicked', () => {
    // Reported from the running console: ticking a variable on a first load did nothing.
    tick('MFA_ENFORCEMENT').checked = true;
    tick('MFA_ENFORCEMENT').dispatchEvent(new Event('change', { bubbles: true }));

    expect(count().textContent).toBe('1 unpublished change.');
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
    expect(count().textContent).toBe('1 unpublished change.');
  });

  it('finds the form at all, which is the failure that looks like nothing happening', () => {
    expect(document.querySelector('form[data-keys]')).not.toBeNull();
    expect(document.querySelector('[data-selection] [data-detail]')).not.toBeNull();
  });
});
