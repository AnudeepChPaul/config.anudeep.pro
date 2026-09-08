/**
 * Keeps each key's tick in step with whether its value actually changed.
 *
 * Server-rendered `checked` is decided when the page is built, so without this, typing a new
 * value changes nothing until a reload — the tick would say "unchanged" while the field says
 * otherwise. Every control carries what it started as in `data-original`; this compares against
 * that rather than tracking edits, so typing a value and typing it back leaves no trace.
 *
 * Ticks stay overridable in one direction only. On an unchanged key, setting one by hand stops
 * it following the value, because you have said something the comparison cannot know: send this
 * unchanged key to the next environment. A key you have actually changed cannot be unticked —
 * the form posts every field, so an edited-but-unticked key would be written into the draft
 * document and then left out of the change set, which reads on screen as an edit that was
 * accepted and then silently lost. If you do not want the change, undo the change.
 */
(() => {
  const form = document.querySelector('form[data-keys]');
  if (!form) return;

  /** Keys whose tick the person set themselves; the comparison leaves those alone. */
  const claimed = new Set();

  const currentValue = (control) =>
    control.type === 'checkbox' ? String(control.checked) : String(control.value);

  const isDirty = (control) => currentValue(control) !== control.getAttribute('data-original');

  const controlFor = (key) => form.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const tickFor = (key) => form.querySelector(`input[data-select="${CSS.escape(key)}"]`);

  const LOCKED =
    'This value was changed, so it goes with the draft. Put the old value back to drop it.';

  const syncTick = (control) => {
    const key = control.getAttribute('data-key');
    if (!key) return;

    const tick = tickFor(key);
    if (!tick) return;

    const dirty = isDirty(control);
    if (dirty) {
      // A change outranks an earlier by-hand untick: the key is going either way now.
      claimed.delete(key);
      tick.checked = true;
      tick.title = LOCKED;
      // A box you cannot clear must not look like one you can; the class is what says so.
      tick.classList.add('locked');
      return;
    }

    tick.title = '';
    tick.classList.remove('locked');
    if (!claimed.has(key)) tick.checked = false;
  };

  const refreshButtons = () => {
    const ticked = form.querySelectorAll('input[name="select"]:checked').length;

    for (const el of form.querySelectorAll('button[data-needs-ticks]')) el.disabled = ticked === 0;

    // The count belongs wherever it is stated — the running sentence and the actions both — so
    // the number you are about to act on is the number you are looking at.
    for (const el of form.querySelectorAll('[data-label]')) {
      const zero = el.getAttribute('data-zero');
      const label = ticked === 0 && zero !== null ? zero : el.getAttribute('data-label');
      el.textContent = label.replace('{n}', String(ticked)).replace('{s}', ticked === 1 ? '' : 's');
    }
  };

  form.addEventListener('input', (event) => {
    const control = event.target.closest('[data-key]');
    if (!control) return;
    syncTick(control);
    refreshButtons();
  });

  form.addEventListener('change', (event) => {
    const control = event.target.closest('[data-key]');
    if (control) syncTick(control);

    if (event.target.name === 'select') {
      const owner = controlFor(event.target.value);
      // Refusing the click rather than disabling the box: a disabled checkbox is not submitted,
      // which would drop the very key it is meant to hold.
      if (owner && isDirty(owner)) event.target.checked = true;
      else claimed.add(event.target.value);
    }

    refreshButtons();
  });

  refreshButtons();

  /**
   * htmx replaces the page body, and a browser only honours `autofocus` when it parses a
   * document — not when an element is swapped in. So the message field, which appears the
   * moment a draft exists and is the only thing left to supply, is focused by hand.
   */
  document.body.addEventListener('htmx:afterSwap', () => {
    document.querySelector('[autofocus]')?.focus();
  });
})();
