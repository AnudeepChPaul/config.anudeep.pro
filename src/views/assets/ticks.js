/** Key selection is independent of edits. Secrets survive a refused swap only in memory. */
(() => {
  const pending = new WeakMap();
  const currentForm = () => document.querySelector('form[data-live-values]');
  const dirty = (form) =>
    [...form.querySelectorAll('[data-original]')].some((field) => {
      const original = field.getAttribute('data-original') ?? '';
      if (field.matches('[data-secret], [type="password"]')) return field.value !== '';
      if (field.type === 'checkbox') return (field.checked ? 'true' : 'false') !== original;
      return field.value !== original;
    });
  const writeAction = (form, spec) => {
    const button = document.createElement('button');
    button.type = 'submit';
    button.className = spec.className;
    button.name = 'intent';
    button.value = spec.intent;
    button.setAttribute('hx-post', spec.post);
    button.setAttribute('hx-target', '#page');
    button.setAttribute('hx-swap', 'innerHTML');
    button.setAttribute('hx-include', form.id ? `#${form.id}` : 'closest form');
    button.setAttribute('hx-vals', JSON.stringify({ intent: spec.intent }));
    if (spec.formAction) button.setAttribute('formaction', spec.formAction);
    const resting = document.createElement('span');
    resting.className = 'resting';
    resting.textContent = spec.label;
    const running = document.createElement('span');
    running.className = 'running';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    running.append(spinner, spec.running);
    button.append(resting, running);
    return button;
  };
  const recipes = (form) => {
    const wanted = [];
    const ticked = form.querySelectorAll('input[name="select"]:checked').length > 0;
    if (ticked && form.dataset.promotePost)
      wanted.push({
        intent: 'promote',
        make: () =>
          writeAction(form, {
            className: 'linkbtn',
            intent: 'promote',
            post: form.dataset.promotePost,
            formAction: form.dataset.promotePost,
            label: form.dataset.promoteLabel || 'Promote',
            running: 'Promoting',
          }),
      });
    if (ticked && form.dataset.deletePost)
      wanted.push({
        intent: 'delete',
        make: () =>
          writeAction(form, {
            className: 'linkbtn no',
            intent: 'delete',
            post: form.dataset.deletePost,
            formAction: form.dataset.deletePost,
            label: 'Delete keys',
            running: 'Checking',
          }),
      });
    if (dirty(form) && form.dataset.savePost)
      wanted.push({
        intent: 'save',
        make: () =>
          writeAction(form, {
            className: 'linkbtn',
            intent: 'save',
            post: form.dataset.savePost,
            label: 'Save',
            running: 'Saving',
          }),
      });
    return wanted;
  };
  const refresh = () => {
    const form = currentForm();
    const line = form?.querySelector('.actionline .idle');
    if (!form || !line) return;
    const wanted = recipes(form);
    for (const extra of [...line.querySelectorAll('button')]) {
      if (!wanted.some((spec) => spec.intent === extra.value)) extra.remove();
    }
    for (const spec of wanted) {
      const existing = line.querySelector(`button[value="${spec.intent}"]`);
      const button = existing ?? spec.make();
      line.append(button);
      if (!existing) globalThis.htmx?.process?.(button);
    }
  };
  const clearTransientNotices = () => {
    for (const notice of document.querySelectorAll('[data-transient]')) {
      setTimeout(() => notice.remove(), 5000);
    }
  };
  const revealFound = () => {
    document.querySelector('.keyrow.found')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  };
  const revealFoundSoon = () => {
    revealFound();
    requestAnimationFrame(() => {
      revealFound();
      requestAnimationFrame(revealFound);
    });
  };
  document.addEventListener('change', refresh);
  document.addEventListener('input', refresh);
  document.addEventListener('htmx:beforeRequest', (event) => {
    const { elt, xhr } = event.detail;
    const form = elt?.closest?.('form[data-live-values]');
    if (!form || !xhr) return;
    pending.set(xhr, {
      action: form.action,
      secrets: [...form.querySelectorAll('input[type="password"]')].map((input) => [
        input.name,
        input.value,
      ]),
    });
  });
  document.addEventListener('htmx:beforeSwap', (event) => {
    const status = event.detail.xhr?.status;
    if (status === 409 || status === 422) {
      event.detail.shouldSwap = true;
      event.detail.isError = false;
    }
  });
  document.addEventListener('htmx:afterSwap', (event) => {
    const xhr = event.detail?.xhr;
    const saved = xhr && pending.get(xhr);
    const form = currentForm();
    if (saved && form?.action === saved.action && (xhr.status === 409 || xhr.status === 422)) {
      for (const [name, value] of saved.secrets) {
        const input = [...form.querySelectorAll('input[type="password"]')].find(
          (input) => input.name === name,
        );
        if (input) input.value = value;
      }
    }
    if (xhr) pending.delete(xhr);
    refresh();
    clearTransientNotices();
    document.querySelector('[autofocus]')?.focus();
    revealFoundSoon();
  });
  document.addEventListener('htmx:afterSettle', revealFoundSoon);
  window.addEventListener('load', revealFoundSoon);
  window.addEventListener('pageshow', revealFoundSoon);
  refresh();
  clearTransientNotices();
  revealFoundSoon();
})();
