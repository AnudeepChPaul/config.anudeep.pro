// @vitest-environment jsdom

import { type KeyRow, renderProduct } from '@config/src/views/pages.js';
import { beforeEach, describe, expect, it } from 'vitest';

const definition = (over: Record<string, unknown> = {}) =>
  ({ type: 'string', secret: false, ...over }) as unknown as KeyRow['definition'];
const toolbar = {
  service: 'iam',
  environment: 'dev',
  environments: ['dev', 'stage'],
  etag: 'e',
  rows: [row()],
  version: 3,
  next: 'stage',
  retiring: false,
  missing: false,
  fragment: true,
} as Parameters<typeof renderProduct>[0];

/**
 * Every write action owns its loader.
 *
 * htmx marks the element that ISSUED a request with .htmx-request, and the rule that swaps
 * resting for running is `.htmx-request .resting`. With the request on the form, the class landed
 * on the form: the global publish, whose button sat in the page header and submitted through
 * `form="publish-products"`, was outside it and never span at all, while the product toolbar --
 * one form holding both Save and Publish -- span BOTH whichever was pressed.
 *
 * So each action issues its own request. The class then lands on the button, and the only spinner
 * that runs is the one belonging to the action that was pressed.
 *
 * Publishing is gone with the direct-write cutover. The shape that caused the defect is not:
 * one form on the product page still holds three actions -- Save, Promote and Delete keys.
 */
function row(over: Partial<KeyRow> = {}): KeyRow {
  return {
    key: 'MFA_ENFORCEMENT',
    definition: definition({ type: 'enum', values: ['optional', 'all'] }),
    value: 'all',
    ...over,
  };
}

const load = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};

const actions = () => [...document.querySelectorAll('button.linkbtn, button')];

describe('a write action issues its own request', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('gives two actions in one form separate requests, so one spinner cannot run the other', () => {
    load(String(renderProduct(toolbar)));
    const wired = actions().filter((b) => b.getAttribute('hx-post'));
    expect(wired.length, 'every action carries its own request').toBeGreaterThan(1);
    const posts = wired.map((b) => b.getAttribute('hx-post'));
    expect(
      new Set(posts).size,
      'they are separate elements, not one shared indicator',
    ).toBeGreaterThan(0);
  });

  it('carries the intent on the action rather than relying on the submitter', () => {
    load(String(renderProduct(toolbar)));
    // htmx does not send a submit button's name/value when the BUTTON issues the request, so an
    // intent expressed only as name/value would be lost and the route would guess.
    const save = document.querySelector('button[value="save"]');
    expect(save?.getAttribute('hx-vals') ?? '').toContain('save');
    const remove = document.querySelector('button[value="delete"]');
    expect(remove?.getAttribute('hx-vals') ?? '').toContain('delete');
  });

  it('includes the form on an action whose checkboxes it must submit', () => {
    // Promote and Delete act on what is ticked. Without hx-include the button posts nothing,
    // which is the same defect the global publish had for the same reason.
    load(String(renderProduct(toolbar)));
    for (const value of ['promote', 'delete']) {
      const button = document.querySelector(`button[value="${value}"]`);
      expect(button?.getAttribute('hx-include'), value).toBeTruthy();
    }
  });
});
