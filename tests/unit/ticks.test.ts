// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, expect, it } from 'vitest';

// D4 replaces dirty-field locking with independent selection.
beforeAll(() => {
  new Function(readFileSync(join(process.cwd(), 'src/views/assets/ticks.js'), 'utf8'))();
});
beforeEach(() => {
  document.body.innerHTML =
    '<div id="page"><form data-live-values><input name="select" value="A" type="checkbox" data-select="A"><input name="key.A" value="one"><input name="key.SECRET" type="password"><button name="intent" value="save">Save</button><button data-selection-action>Promote</button></form></div>';
  document.dispatchEvent(new CustomEvent('htmx:afterSwap', { detail: {} }));
});
it('does not select or lock a changed key, and Save needs no selection', () => {
  const input = document.querySelector<HTMLInputElement>('[name="key.A"]')!;
  input.value = 'two';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
  expect(box.checked).toBe(false);
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect(box.checked).toBe(false);
  expect(box.classList.contains('locked')).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('[value="save"]')!.disabled).toBe(false);
});
it('requires selection only for Promote and Delete', () => {
  const button = document.querySelector<HTMLButtonElement>('[data-selection-action]')!;
  expect(button.disabled).toBe(true);
  const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect(button.disabled).toBe(false);
});
it('swaps conflict and validation pages but not server failures', () => {
  for (const status of [409, 422, 500]) {
    const detail = { xhr: { status }, shouldSwap: false, isError: true };
    document.dispatchEvent(new CustomEvent('htmx:beforeSwap', { detail }));
    expect(detail.shouldSwap).toBe(status !== 500);
  }
});
it('keeps a typed secret only in browser memory across a conflict', () => {
  const form = document.querySelector('form')!;
  const secret = form.querySelector<HTMLInputElement>('[type="password"]')!;
  secret.value = 'only-in-browser';
  const xhr = { status: 409 };
  document.dispatchEvent(new CustomEvent('htmx:beforeRequest', { detail: { elt: form, xhr } }));
  document.dispatchEvent(
    new CustomEvent('htmx:beforeSwap', { detail: { xhr, shouldSwap: false, isError: true } }),
  );
  secret.value = '';
  document.dispatchEvent(new CustomEvent('htmx:afterSwap', { detail: { xhr } }));
  expect(secret.value).toBe('only-in-browser');
  expect(document.body.innerHTML).not.toContain('only-in-browser');
});
