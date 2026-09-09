/**
 * Which fields a key row shows.
 *
 * A schema key does not have the same shape for every type. Showing every field for every type
 * asks the operator to know which ones the server is about to ignore, and invites filling in a
 * box that will be refused: min and max mean nothing to a string, values mean nothing to a bool,
 * and a secret must not carry a value at all.
 *
 *   string  -> secret, values, default
 *   secret  -> values and default go away; it is still a string, because that is what the file
 *              records: `type: string` with `secret: true`
 *   int     -> min, max, default
 *   others  -> default only
 *
 * This is an enhancement, not the rule. With no script every field is visible and the server
 * refuses what does not belong; `buildSchema` is what actually decides, because a POST body is
 * user input whatever the form did.
 */
(() => {
  /** Which types a field belongs to, read off the markup rather than listed here twice. */
  const belongs = (field, type) => {
    const only = field.getAttribute('data-when');
    return !only || only.split(' ').includes(type);
  };

  const apply = (row) => {
    const select = row.querySelector('[data-key-type]');
    if (!select) return;
    const type = select.value;
    const secretBox = row.querySelector('[data-key-secret]');
    // Secret is a property of a string, so it cannot survive a change to another type. Leaving
    // it ticked but hidden would post an int that claims to be secret, and the server would
    // refuse a form that looked right on screen.
    if (secretBox && type !== 'string' && secretBox.checked) secretBox.checked = false;
    const secret = Boolean(secretBox && secretBox.checked);

    // The default box serves every type, so its own type follows the key's: a number for an
    // int, text for the rest. Set here rather than in the markup because there is one box and
    // it has to go back — a string default typed into a number input is untypeable.
    const fallback = row.querySelector('[data-key-default]');
    if (fallback) {
      const numeric = type === 'int';
      fallback.type = numeric ? 'number' : 'text';
      if (numeric) fallback.step = '1';
      else fallback.removeAttribute('step');
    }

    for (const field of row.querySelectorAll('[data-when]')) {
      const wanted = belongs(field, type) && !(secret && field.hasAttribute('data-not-secret'));
      field.hidden = !wanted;
      // A hidden field must not post what someone typed into it before it was hidden: the
      // server would refuse values on a secret, naming a box that is no longer on the screen.
      if (!wanted) {
        for (const input of field.querySelectorAll('input, select')) {
          if (input.type !== 'checkbox') input.value = '';
        }
      }
    }
  };

  const applyAll = () => {
    for (const row of document.querySelectorAll('[data-key-row]')) apply(row);
  };

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (!target.matches('[data-key-type], [data-key-secret]')) return;
    const row = target.closest('[data-key-row]');
    if (row) apply(row);
  });

  /**
   * Leaving the form.
   *
   * The question is asked in the action line rather than through hx-confirm. The browser's own
   * dialog is modal, styled by the browser and not by this console, and blocks every event until
   * it is answered -- so a question about the page arrives from somewhere that looks nothing
   * like it.
   *
   * Asked only when there is something to lose. A form nobody has typed into has nothing to
   * confirm, and asking anyway teaches the operator to dismiss the question without reading it.
   *
   * With no script the link is an ordinary link and simply leaves. A form that could not be left
   * without JavaScript would be worse than one that leaves without asking.
   */
  const touched = (form) => {
    for (const input of form.querySelectorAll('input, select, textarea')) {
      if (input.type === 'checkbox') continue;
      if (input.name === 'environment') continue;
      // A select always has a value; only a CHANGED one counts as something typed.
      if (input.tagName === 'SELECT') {
        if (input.selectedIndex > 0) return true;
        continue;
      }
      if ((input.value || '').trim().length > 0) return true;
    }
    return false;
  };

  /**
   * CAPTURE, not bubble.
   *
   * htmx binds its own listener to the element carrying hx-get, and an element's listener runs
   * before a document-level one in the bubble phase -- so stopping propagation there is already
   * too late and the page swaps out from under the question. Capture runs first, everywhere.
   *
   * Verified in a browser rather than in jsdom, which has no htmx to be beaten to the event:
   * removing this flag passes every test here and navigates away in Chrome.
   */
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const archiving = target.closest('[data-archive]');
      if (archiving) {
        // Capture, like discard: htmx binds to the element, and its listener would otherwise run
        // first and follow the link before the question is on screen.
        event.preventDefault();
        event.stopPropagation();
        const row = archiving.closest('[data-retiring-row]');
        const ask = row && row.querySelector('[data-archive-confirm]');
        if (ask) ask.hidden = false;
        archiving.hidden = true;
        return;
      }

      const leaving = target.closest('[data-discard]');
      if (!leaving) return;
      const form = document.querySelector('#new-product');
      if (!form || !touched(form)) return;

      event.preventDefault();
      event.stopPropagation();
      const line = leaving.closest('.actionline');
      const ask = line && line.querySelector('[data-discard-confirm]');
      if (ask) ask.hidden = false;
      leaving.hidden = true;
    },
    true,
  );

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;

    // Archiving asks in the row it was clicked in, for the same reason discarding does: the
    // question is about this product, and a browser dialog answers from somewhere that looks
    // nothing like the page. Unlike discard, there is nothing to lose by asking every time —
    // archiving commits immediately, so it is always worth a second look.
    const archiveKeep = target.closest('[data-archive-keep]');
    if (archiveKeep) {
      const row = archiveKeep.closest('[data-retiring-row]');
      const ask = row && row.querySelector('[data-archive-confirm]');
      const start = row && row.querySelector('[data-archive]');
      if (ask) ask.hidden = true;
      if (start) start.hidden = false;
      return;
    }

    const keep = target.closest('[data-keep]');
    if (keep) {
      const line = keep.closest('.actionline');
      const ask = line && line.querySelector('[data-discard-confirm]');
      const discard = line && line.querySelector('[data-discard]');
      if (ask) ask.hidden = true;
      if (discard) discard.hidden = false;
      return;
    }
  });

  applyAll();
  document.addEventListener('htmx:afterSwap', applyAll);
})();
