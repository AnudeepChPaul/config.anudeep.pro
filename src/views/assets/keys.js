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

  applyAll();
  document.addEventListener('htmx:afterSwap', applyAll);
})();
