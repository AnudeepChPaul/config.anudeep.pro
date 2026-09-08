/**
 * Keeps each key's tick in step with whether its value actually changed.
 *
 * Server-rendered `checked` is decided when the page is built, so without this, typing a new
 * value changes nothing until a reload — the tick would say "unchanged" while the field says
 * otherwise. Every control carries what it started as in `data-original`; this compares against
 * that rather than tracking edits, so typing a value and typing it back leaves no trace.
 *
 * Ticks stay overridable. Once you set one by hand it stops following the value, because you
 * have said something the comparison cannot know: hold this change back from the publish, or
 * send this unchanged key to the next environment.
 */
(() => {
  const form = document.querySelector('form[data-keys]');
  if (!form) return;

  /** Keys whose tick the person set themselves; the comparison leaves those alone. */
  const claimed = new Set();

  const currentValue = (control) =>
    control.type === 'checkbox' ? String(control.checked) : String(control.value);

  const syncTick = (control) => {
    const key = control.getAttribute('data-key');
    if (!key || claimed.has(key)) return;

    const tick = form.querySelector(`input[data-select="${CSS.escape(key)}"]`);
    if (tick) tick.checked = currentValue(control) !== control.getAttribute('data-original');
  };

  const refreshButtons = () => {
    const ticked = form.querySelectorAll('input[name="select"]:checked').length;

    for (const button of form.querySelectorAll('button[data-needs-ticks]')) {
      button.disabled = ticked === 0;
      // The count belongs on the button, so the number you are about to act on is the number
      // you are looking at.
      const label = button.getAttribute('data-label');
      if (label) button.textContent = label.replace('{n}', String(ticked));
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
    if (event.target.name === 'select') claimed.add(event.target.value);
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
