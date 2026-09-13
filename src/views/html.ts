/**
 * HTML escaping for template interpolations.
 *
 * Everything this UI displays is attacker-influenced: values come from a repository edited by
 * people and by GitHub pushes, and key names come from schema files. A value like
 * `</textarea><script>` reaching the page unescaped turns the config editor into a way to run
 * script in an operator's session — the session that is about to change MFA enforcement.
 *
 * Escaping is the default in compiled Eta templates (`autoEscape: true`). This function is the
 * escape implementation those templates call.
 */

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  // Ampersand first. Replacing `<` before `&` would turn `&lt;` into `&amp;lt;`, and doing it
  // the other way round can reconstitute a live `<` from `&amp;#60;`.
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
