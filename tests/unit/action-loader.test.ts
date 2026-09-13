// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type KeyRow, renderProduct } from '@config/src/views/pages.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
 * htmx marks the element that ISSUED a request with .htmx-request. The buttons are not in the
 * first HTML — they are inserted into the idle span when a change or a tick needs them — and
 * each still carries its own hx-post so one spinner cannot run the other.
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
  document.dispatchEvent(new CustomEvent('htmx:afterSwap', { detail: {} }));
  return document.body;
};

beforeAll(() => {
  new Function(readFileSync(join(process.cwd(), 'src/views/assets/ticks.js'), 'utf8'))();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the live form ships recipes, not hidden actions', () => {
  it('renders one idle span and no write buttons', () => {
    load(String(renderProduct(toolbar)));
    const line = document.querySelector('.actionline') as HTMLElement;
    expect(line.querySelectorAll(':scope > span')).toHaveLength(1);
    expect(line.querySelector('.idle')).not.toBeNull();
    expect(line.querySelector('button[value="save"]')).toBeNull();
    expect(line.querySelector('button[value="promote"]')).toBeNull();
    expect(line.querySelector('[data-open-add-keys]')?.textContent).toMatch(/\+ Add variable/);
    expect(line.querySelector('.acts, .selection')).toBeNull();
  });

  it('names the posts the script will turn into buttons', () => {
    load(String(renderProduct(toolbar)));
    const form = document.querySelector('form[data-live-values]') as HTMLFormElement;
    expect(form.getAttribute('data-save-post')).toBe('/p/iam/dev');
    expect(form.getAttribute('data-promote-post')).toBe('/promote');
    expect(form.getAttribute('data-promote-label')).toBe('Promote to stage');
    expect(form.getAttribute('data-delete-post')).toBe('/p/iam/delete-keys');
  });
});

describe('a write action issues its own request', () => {
  const activate = () => {
    load(String(renderProduct(toolbar)));
    const input = document.querySelector<HTMLInputElement>('[name="key.MFA_ENFORCEMENT"]')!;
    input.value = 'optional';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('gives two actions in one form separate requests, so one spinner cannot run the other', () => {
    activate();
    const wired = [...document.querySelectorAll('button[hx-post]')];
    expect(wired.length, 'every action carries its own request').toBeGreaterThan(1);
    expect(new Set(wired.map((button) => button.getAttribute('hx-post'))).size).toBeGreaterThan(1);
  });

  it('carries the intent on the action rather than relying on the submitter', () => {
    activate();
    expect(document.querySelector('button[value="save"]')?.getAttribute('hx-vals') ?? '').toContain(
      'save',
    );
    expect(
      document.querySelector('button[value="delete"]')?.getAttribute('hx-vals') ?? '',
    ).toContain('delete');
  });

  it('includes the form on an action whose checkboxes it must submit', () => {
    activate();
    for (const value of ['promote', 'delete']) {
      expect(document.querySelector(`button[value="${value}"]`)?.getAttribute('hx-include'), value).toBeTruthy();
    }
  });
});

describe('the product toolbar keeps writes on the right', () => {
  it('inserts Promote, then Delete, then Save into the idle span', () => {
    load(String(renderProduct(toolbar)));
    const input = document.querySelector<HTMLInputElement>('[name="key.MFA_ENFORCEMENT"]')!;
    input.value = 'optional';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const idle = document.querySelector('.idle') as HTMLElement;
    expect(
      [...idle.querySelectorAll(':scope > button')].map((button) => button.getAttribute('value')),
    ).toEqual(['promote', 'delete', 'save']);
    expect(document.querySelector('button[value="delete"]')?.className).toContain('no');
  });
});
