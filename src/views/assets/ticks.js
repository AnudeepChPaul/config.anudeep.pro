/** Key selection is independent of edits. Secrets survive a refused swap only in memory. */
(() => {
  const pending = new WeakMap();
  const currentForm = () => document.querySelector('form[data-live-values]');
  const refresh = () => {
    const form = currentForm();
    if (!form) return;
    const selected = form.querySelectorAll('input[name="select"]:checked').length;
    for (const button of form.querySelectorAll('[data-selection-action]')) {
      button.disabled = selected === 0;
    }
  };
  const clearTransientNotices = () => {
    for (const notice of document.querySelectorAll('[data-transient]')) {
      setTimeout(() => notice.remove(), 5000);
    }
  };
  document.addEventListener('change', refresh);
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
  });
  refresh();
  clearTransientNotices();
})();
