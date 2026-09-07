/**
 * Rendering primitives.
 *
 * Everything this UI displays is attacker-influenced: values come from a repository edited by
 * people and by GitHub pushes, and key names come from schema files. A value like
 * `</textarea><script>` reaching the page unescaped turns the config editor into a way to run
 * script in an operator's session — the session that is about to change MFA enforcement.
 *
 * So escaping is the default and marking something safe is the explicit act, rather than the
 * other way round.
 */

/** A fragment that has already been escaped and must not be escaped again. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

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

/** Marks a string as already-safe markup. Every use is a place to look during a review. */
export const raw = (value: string): SafeHtml => new SafeHtml(value);

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value) && value.every((item) => item instanceof SafeHtml)) {
    return value.map((item) => String(item)).join('');
  }
  return escapeHtml(value);
}

/** Interpolations are escaped unless they are already SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  const out = strings.reduce(
    (acc, part, index) => acc + part + (index < values.length ? render(values[index]) : ''),
    '',
  );
  return new SafeHtml(out);
}
