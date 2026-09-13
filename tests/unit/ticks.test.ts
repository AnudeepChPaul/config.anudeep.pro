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
      <div class="actionline"><span class="idle"><span data-idle-facts>3 variables in dev · serving revision 3<span class="peek unsynced-badge" tabindex="0"><span class="chip wait">1 unsynced change</span><span class="detail"><span class="wasnow"><span class="diffkey">SESSION_TTL</span> <span class="was">30</span><span class="arrow">→</span><span class="is">60</span></span></span></span></span></span></div>
      <input name="select" value="A" type="checkbox" data-select="A">
      <input name="select" value="B" type="checkbox" data-select="B">
      <input name="select" value="C" type="checkbox" data-select="C">
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
  expect(idle().querySelector(':scope > button')).toBeNull();
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
  expect([...idle().querySelectorAll(':scope > button')].map((button) => button.value)).toEqual([
    'promote',
    'delete',
  ]);
  expect(save()).toBeNull();
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect(promote()).toBeNull();
  expect(remove()).toBeNull();
});
it('replaces the idle facts with a selection count and Select all while a key is ticked', () => {
  const facts = idle().querySelector('[data-idle-facts]') as HTMLElement;
  const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
  expect(facts.hidden).toBe(false);
  expect(idle().querySelector('.selection')).toBeNull();
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect(facts.hidden).toBe(true);
  const selection = idle().querySelector('.selection') as HTMLElement;
  expect(selection.querySelector('[data-selection-count]')?.textContent).toBe('1 of 3 selected');
  expect(selection.querySelector('[data-selection-count]')?.className).toContain('linkbtn');
  const none = selection.querySelector('[data-select-none]') as HTMLButtonElement;
  const all = selection.querySelector('[data-select-all]') as HTMLButtonElement;
  expect(none.textContent).toBe('Deselect');
  expect(none.className).toBe('linkbtn no');
  expect(none.nextElementSibling).toBe(all);
  expect(all.textContent).toBe('Select all');
  expect(all.className).toContain('linkbtn');
  expect(all.className).toContain('ink');
  all.click();
  expect(
    [...document.querySelectorAll<HTMLInputElement>('input[name="select"]')].every(
      (input) => input.checked,
    ),
  ).toBe(true);
  expect(selection.querySelector('[data-selection-count]')?.textContent).toBe('3 of 3 selected');
  none.click();
  expect(facts.hidden).toBe(false);
  expect(idle().querySelector('.selection')).toBeNull();
  expect(idle().textContent).toContain('3 variables in dev');
});
it('drops the idle unsynced badge while a key is ticked', () => {
  const badge = idle().querySelector('[data-idle-facts] > .unsynced-badge') as HTMLElement;
  expect(badge.hidden).toBe(false);
  const box = document.querySelector<HTMLInputElement>('[name="select"]')!;
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect((idle().querySelector('[data-idle-facts]') as HTMLElement).hidden).toBe(true);
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect((idle().querySelector('[data-idle-facts]') as HTMLElement).hidden).toBe(false);
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
