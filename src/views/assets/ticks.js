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
    const total = form.querySelectorAll('input[name="select"]').length;
    for (const el of form.querySelectorAll('[data-label]')) {
      el.textContent = el
        .getAttribute('data-label')
        .replace('{n}', String(ticked))
        .replace('{t}', String(total))
        .replace('{s}', ticked === 1 ? '' : 's');
    }

    // Nothing ticked and nothing written down: the toolbar has nothing to act on, so it shows
    // where you are instead. A saved draft counts as something, since it is publishable
    // whatever the ticks say.
    const actions = form.querySelector('[data-actions]');
    if (actions) {
      const idle = ticked === 0 && actions.getAttribute('data-has-draft') === null;
      const selection = actions.querySelector('[data-selection]');
      const where = actions.querySelector('.idle');
      if (selection) selection.hidden = idle;
      if (where) where.hidden = !idle;
    }
  };

  /**
   * The panel behind the count: which keys are selected, and what each one is about to change.
   *
   * The server cannot render this before a draft is saved — it has never seen these edits — so
   * it is built from the page. Text nodes throughout: a config value is arbitrary text, and
   * assembling this as markup would let a value close a tag.
   */
  const refreshDetail = () => {
    // Scoped to the selection: the idle line carries a panel of its own — what differs from
    // the next environment — and it renders first, so "the first panel in the form" wrote the
    // selection into that one and left this one showing the drift.
    const panel = form.querySelector('[data-selection] [data-detail]');
    if (!panel) return;

    const heading = panel.querySelector('h3');
    panel.textContent = '';
    if (heading) panel.append(heading);

    const line = (parts) => {
      const row = document.createElement('div');
      for (const [text, className] of parts) {
        const span = document.createElement(className === 'key' ? 'strong' : 'span');
        if (className && className !== 'key') span.className = className;
        span.textContent = text;
        row.append(span, document.createTextNode(' '));
      }
      panel.append(row);
    };

    for (const tick of form.querySelectorAll('input[name="select"]:checked')) {
      const key = tick.value;
      const control = controlFor(key);
      if (!control) continue;

      if (tick.getAttribute('data-secret') !== null) {
        line([
          [key, 'key'],
          ['changed — value hidden', 'hint'],
        ]);
        continue;
      }

      // What it is published as, when that is known: `data-original` is what the field was
      // rendered with, which for a saved draft is the draft's own value.
      const was = tick.getAttribute('data-published') ?? control.getAttribute('data-original');
      const now = currentValue(control);

      if (was === now)
        line([
          [key, 'key'],
          ['unchanged — selected to promote', 'hint'],
        ]);
      else
        line([
          [key, 'key'],
          [was || '(unset)', 'was'],
          ['→', 'hint'],
          [now || '(removed)', 'is'],
        ]);
    }
  };

  form.addEventListener('input', (event) => {
    const control = event.target.closest('[data-key]');
    if (!control) return;
    syncTick(control);
    refreshButtons();
    refreshDetail();
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
    refreshDetail();
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
