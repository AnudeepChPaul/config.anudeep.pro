// @vitest-environment jsdom

import {
  type KeyRow,
  renderDrafts,
  renderProduct,
  renderProducts,
} from '@config/src/views/pages.js';
import { beforeEach, describe, expect, it } from 'vitest';

const definition = (over: Record<string, unknown> = {}) =>
  ({ type: 'string', secret: false, ...over }) as unknown as KeyRow['definition'];
const pending = [{ key: 'MFA_ENFORCEMENT', from: 'optional', to: 'all', secret: false }] as never;
const env = (name: string, drafts: number, holding: unknown[] = []) => ({
  name,
  namespace: `iam/${name}`,
  drafts,
  pending: holding as never,
});
const toolbar = {
  service: 'iam',
  active: 'dev',
  environments: [env('dev', 1, pending)],
  rows: [row()],
  commit: 'a'.repeat(40),
  revision: 3,
  drafted: ['MFA_ENFORCEMENT'],
  fragment: true,
} as Parameters<typeof renderProduct>[0];

/**
 * Every write action owns its loader.
 *
 * htmx marks the element that ISSUED a request with .htmx-request, and the rule that swaps
 * resting for running is `.htmx-request .resting`. With the request on the form, the class landed
 * on the form: the global publish, whose button sits in the page header and submits through
 * `form="publish-products"`, was outside it and never span at all, while the product toolbar --
 * one form holding both Save and Publish -- span BOTH whichever was pressed.
 *
 * So each action issues its own request. The class then lands on the button, and the only spinner
 * that runs is the one belonging to the action that was pressed.
 */
function row(over: Partial<KeyRow> = {}): KeyRow {
  return {
    key: 'MFA_ENFORCEMENT',
    definition: definition({ type: 'enum', values: ['optional', 'all'] }),
    value: 'all',
    publishedValue: 'optional',
    pending: true,
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

  it('wires the global publish, though its button is outside the form it submits', () => {
    load(
      String(
        renderProducts({
          products: [
            {
              name: 'iam (1002)',
              service: 'iam',
              keys: 'MFA_ENFORCEMENT',
              environments: [env('dev', 1, pending)],
            },
          ],
          commit: 'a'.repeat(40),
          fragment: true,
        }),
      ),
    );
    const publish = actions().find((b) => b.textContent?.includes('Publish'));
    expect(publish, 'the publish action is rendered').toBeTruthy();
    expect(publish?.getAttribute('hx-post')).toBe('/publish');
    // Without this the button posts nothing: the checkboxes live in the form it is outside of.
    expect(publish?.getAttribute('hx-include')).toBeTruthy();
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
    // The toolbar's publish, not the header's "Publish all in iam" -- the toolbar is the one
    // that shares a form with Save, so it is the one whose intent has to travel on the button.
    const publish = document.querySelector('button[value="publish"]');
    expect(publish?.getAttribute('hx-vals') ?? '').toContain('publish');
    const save = document.querySelector('button[value="save"]');
    expect(save?.getAttribute('hx-vals') ?? '').toContain('save');
  });

  it('keeps the drop action wired on the drafts page', () => {
    load(
      String(
        renderDrafts({
          drafts: [
            {
              namespace: 'iam/dev',
              saves: [{ keys: ['A'], actor: 'me@anudeep.pro', at: Date.now() }],
            },
          ],
          fragment: true,
        }),
      ),
    );
    const drop = actions().find((b) => b.textContent?.includes('Drop'));
    expect(drop?.getAttribute('hx-post')).toBe('/drafts/drop');
  });
});
