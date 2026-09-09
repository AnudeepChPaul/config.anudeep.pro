// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderNewProduct } from '@config/src/views/pages.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Which fields a key row shows.
 *
 * A schema key does not have the same shape for every type, and a form that shows every field
 * for every type asks the operator to know which ones the server will ignore. Worse, it invites
 * filling in a box that is about to be refused: min and max mean nothing to a string, and a
 * secret must not carry a value at all.
 *
 * The rules, from the operator:
 *   string  -> a secret checkbox, a values list, and a default
 *   secret  -> the values list and the default go away; it stays a string
 *   int     -> min and max, and a default
 *   others  -> a default only
 *
 * The script is the enhancement, not the rule. With no script every field is visible and the
 * server refuses what does not belong -- `buildSchema` is what actually decides.
 */
const source = readFileSync(join(process.cwd(), 'src/views/assets/keys.js'), 'utf8');

const run = () => {
  document.body.innerHTML = String(renderNewProduct({ environments: ['dev'], fragment: true }));
  new Function(source)();
};

const row = () => document.querySelector('.keydraft') as HTMLElement;
const typeSelect = () => row().querySelector('select') as HTMLSelectElement;
const secretBox = () => row().querySelector('[name$=".secret"]') as HTMLInputElement;
const fieldFor = (suffix: string) =>
  row().querySelector(`[name$=".${suffix}"]`)?.closest('.field') as HTMLElement | null;
const secretField = () => secretBox()?.closest('.field') as HTMLElement | null;

/**
 * Visible means no hidden ancestor, not merely "this element is not hidden".
 *
 * The secret checkbox is toggled by its ROW, so asking only about the label said "visible" for
 * a control nobody could see.
 */
const shown = (element: HTMLElement | null): boolean => {
  for (let node = element; node; node = node.parentElement) {
    if (node.hidden) return false;
    if (node === document.body) break;
  }
  return Boolean(element);
};

const chooseType = (value: string) => {
  typeSelect().value = value;
  typeSelect().dispatchEvent(new Event('change', { bubbles: true }));
};

const tickSecret = (checked: boolean) => {
  secretBox().checked = checked;
  secretBox().dispatchEvent(new Event('change', { bubbles: true }));
};

beforeEach(run);

describe('a string key', () => {
  it('offers secret, values and a default', () => {
    chooseType('string');

    expect(shown(secretField()), 'secret').toBe(true);
    expect(shown(fieldFor('values')), 'values').toBe(true);
    expect(shown(fieldFor('default')), 'default').toBe(true);
  });

  it('offers no bounds, which mean nothing to a string', () => {
    chooseType('string');

    expect(shown(fieldFor('min'))).toBe(false);
    expect(shown(fieldFor('max'))).toBe(false);
  });
});

describe('where the secret checkbox sits', () => {
  // On the same line as Key and Type it read as part of the key's identity, and it is not: it
  // is a property of a string, and ticking it changes which fields below it exist.
  it('is on its own line, not beside the key and its type', () => {
    chooseType('string');
    const typeRow = typeSelect().closest('.fieldrow');
    const secretRow = secretBox().closest('.fieldrow');

    expect(secretRow).toBeTruthy();
    expect(secretRow).not.toBe(typeRow);
  });

  it('still comes before the fields it governs', () => {
    chooseType('string');
    const rows = [...row().querySelectorAll('.fieldrow')];
    const secretRow = secretBox().closest('.fieldrow') as HTMLElement;
    const valuesRow = (row().querySelector('[name$=".values"]') as HTMLElement).closest(
      '.fieldrow',
    ) as HTMLElement;

    expect(rows.indexOf(secretRow)).toBeLessThan(rows.indexOf(valuesRow));
  });
});

describe('a secret', () => {
  it('takes away the values and the default, and stays a string', () => {
    chooseType('string');
    tickSecret(true);

    expect(shown(fieldFor('values')), 'values').toBe(false);
    expect(shown(fieldFor('default')), 'default').toBe(false);
    expect(typeSelect().value).toBe('string');
  });

  it('gives them back when it stops being a secret', () => {
    chooseType('string');
    tickSecret(true);
    tickSecret(false);

    expect(shown(fieldFor('values'))).toBe(true);
    expect(shown(fieldFor('default'))).toBe(true);
  });

  // Otherwise a value typed before ticking secret is posted with it, and the server refuses a
  // form that looks correct on screen.
  it('clears anything already typed into them', () => {
    chooseType('string');
    const values = row().querySelector('[name$=".values"]') as HTMLInputElement;
    const fallback = row().querySelector('[name$=".default"]') as HTMLInputElement;
    values.value = 'optional, all';
    fallback.value = 'all';

    tickSecret(true);

    expect(values.value).toBe('');
    expect(fallback.value).toBe('');
  });
});

describe('an int key', () => {
  it('offers min, max and a default', () => {
    chooseType('int');

    expect(shown(fieldFor('min')), 'min').toBe(true);
    expect(shown(fieldFor('max')), 'max').toBe(true);
    expect(shown(fieldFor('default')), 'default').toBe(true);
  });

  it('offers neither values nor secret, which it cannot have', () => {
    chooseType('int');

    expect(shown(fieldFor('values')), 'values').toBe(false);
    expect(shown(secretField()), 'secret').toBe(false);
  });
});

describe('every other type', () => {
  for (const type of ['bool', 'url', 'string[]']) {
    it(`offers ${type} a default and nothing else`, () => {
      chooseType(type);

      expect(shown(fieldFor('default')), 'default').toBe(true);
      expect(shown(fieldFor('values')), 'values').toBe(false);
      expect(shown(fieldFor('min')), 'min').toBe(false);
      expect(shown(secretField()), 'secret').toBe(false);
    });
  }

  // Ticking secret on a string and then choosing int would otherwise leave a hidden checkbox
  // still ticked, and the server would refuse an int that claims to be secret.
  it('unticks a secret left behind by a change of type', () => {
    chooseType('string');
    tickSecret(true);
    chooseType('int');

    expect(secretBox().checked).toBe(false);
  });
});
