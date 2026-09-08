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
  /**
   * The form is looked up per event, never held.
   *
   * htmx replaces the contents of #page on every tab click and every save, so a form captured
   * once is detached on the first navigation — along with any listener bound to it. The page
   * then looks alive and does nothing: ticking a box changed no count and selected nothing.
   * Listening on the document survives every swap, because the document is the one node htmx
   * never replaces.
   */
  const currentForm = () => document.querySelector('form[data-keys]');

  /** Keys whose tick the person set themselves; the comparison leaves those alone. */
  let claimed = new Set();

  const currentValue = (control) =>
    control.type === 'checkbox' ? String(control.checked) : String(control.value);

  const isDirty = (control) => currentValue(control) !== control.getAttribute('data-original');

  const controlFor = (form, key) => form.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const tickFor = (form, key) => form.querySelector(`input[data-select="${CSS.escape(key)}"]`);

  const LOCKED =
    'This value was changed, so it goes with the draft. Put the old value back to drop it.';

  const syncTick = (form, control) => {
    const key = control.getAttribute('data-key');
    if (!key) return;

    const tick = tickFor(form, key);
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

  const refreshButtons = (form) => {
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
  const refreshDetail = (form) => {
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
      const control = controlFor(form, key);
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

  const refresh = (form) => {
    refreshButtons(form);
    refreshDetail(form);
  };

  document.addEventListener('input', (event) => {
    const form = event.target.closest?.('form[data-keys]');
    const control = event.target.closest?.('[data-key]');
    if (!form || !control) return;
    syncTick(form, control);
    refresh(form);
  });

  document.addEventListener('change', (event) => {
    const form = event.target.closest?.('form[data-keys]');
    if (!form) return;

    const control = event.target.closest('[data-key]');
    if (control) syncTick(form, control);

    if (event.target.name === 'select') {
      const owner = controlFor(form, event.target.value);
      // Refusing the click rather than disabling the box: a disabled checkbox is not submitted,
      // which would drop the very key it is meant to hold.
      if (owner && isDirty(owner)) event.target.checked = true;
      else claimed.add(event.target.value);
    }

    refresh(form);
  });

  const initial = currentForm();
  if (initial) refresh(initial);

  /**
   * A swap brings a different page, or the same page rebuilt by the server.
   *
   * Its counts have to be recomputed rather than inherited — the state it was rendered with is
   * the server's, and the ticks a person set by hand on the page that was just thrown away do
   * not apply to the keys on this one.
   *
   * `autofocus` is honoured only when a browser parses a document, never when an element is
   * swapped in, so the message field — which appears the moment a draft exists and is the only
   * thing left to supply — is focused here by hand.
   */
  document.addEventListener('htmx:afterSwap', () => {
    claimed = new Set();
    const form = currentForm();
    if (form) refresh(form);
    document.querySelector('[autofocus]')?.focus();
  });
})();
