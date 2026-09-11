// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

beforeAll(() => {
  new Function(readFileSync(join(process.cwd(), 'src/views/assets/ticks.js'), 'utf8'))();
});
beforeEach(() => {
  document.body.innerHTML = `<div id="page">
    <form id="config-form" data-live-values data-save-post="/p/iam/dev" data-promote-post="/promote" data-promote-label="Promote to stage" data-delete-post="/p/iam/delete-keys">
      <div class="actionline"><span class="idle">3 variables in dev · serving revision 3</span></div>
      <input name="select" value="A" type="checkbox" data-select="A">
      <input name="key.A" value="one" data-original="one">
      <input name="key.SECRET" type="password" data-original="" data-secret>
    </form>
  </div>`;
  document.dispatchEvent(new CustomEvent('htmx:afterSwap', { detail: {} }));
});

const save = () => document.querySelector<HTMLButtonElement>('button[value="save"]');
const promote = () => document.querySelector<HTMLButtonElement>('button[value="promote"]');
const remove = () => document.querySelector<HTMLButtonElement>('button[value="delete"]');
const idle = () => document.querySelector('.idle') as HTMLElement;

it('does not select or lock a changed key', () => {
  const input = document.querySelector<HTMLInputElement>('[name="key.A"]')!;
  input.value = 'two';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
  expect(box.checked).toBe(false);
  expect(box.classList.contains('locked')).toBe(false);
});
it('starts as one idle span, with no actions in the document', () => {
  expect(idle().querySelectorAll('span')).toHaveLength(0);
  expect(save()).toBeNull();
  expect(promote()).toBeNull();
  expect(remove()).toBeNull();
  expect(document.querySelector('[hidden]')).toBeNull();
});
it('puts Save in that same span only while a value differs from what was loaded', () => {
  const input = document.querySelector<HTMLInputElement>('[name="key.A"]')!;
  input.value = 'two';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(save()?.parentElement).toBe(idle());
  expect(promote()).toBeNull();
  expect(idle().textContent).toContain('3 variables in dev');
  input.value = 'one';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(save()).toBeNull();
});
it('treats a typed secret as a change, and a blank secret as none', () => {
  const secret = document.querySelector<HTMLInputElement>('[type="password"]')!;
  secret.value = 'new-secret';
  secret.dispatchEvent(new Event('input', { bubbles: true }));
  expect(save()).not.toBeNull();
  secret.value = '';
  secret.dispatchEvent(new Event('input', { bubbles: true }));
  expect(save()).toBeNull();
});
it('puts Promote then Delete in that same span only while a key is ticked', () => {
  const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect([...idle().querySelectorAll('button')].map((button) => button.value)).toEqual([
    'promote',
    'delete',
  ]);
  expect(save()).toBeNull();
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect(promote()).toBeNull();
  expect(remove()).toBeNull();
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
it('scrolls a highlighted key as far toward the center as the page allows', () => {
  const row = document.createElement('div');
  row.className = 'row keyrow found';
  document.body.replaceChildren(row);
  const scrollIntoView = vi.fn();
  row.scrollIntoView = scrollIntoView;
  document.dispatchEvent(new CustomEvent('htmx:afterSwap', { detail: {} }));
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
});
