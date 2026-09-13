import type { KeyDraft } from '@config/src/schema/builder.js';
export function keyBodies(body: Record<string, string | string[]>): Array<Record<string, string>> {
  return allKeyBodies(body).filter((row) => (row.name ?? '').trim().length > 0);
}

/** Every posted key row, including blanks. The add-variable control has to round-trip empty
 *  rows or a second click would drop the line the operator is still filling in. */
export function allKeyBodies(
  body: Record<string, string | string[]>,
): Array<Record<string, string>> {
  const rows = new Map<number, Record<string, string>>();
  for (const [field, value] of Object.entries(body)) {
    const match = /^key\.(\d+)\.(\w+)$/.exec(field);
    if (!match) continue;
    const index = Number(match[1]);
    const row = rows.get(index) ?? {};
    row[String(match[2])] = Array.isArray(value) ? String(value[0]) : String(value);
    rows.set(index, row);
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** Those rows as definitions the builder can check. Everything arrives as text and is parsed here. */
export function keyDrafts(body: Record<string, string | string[]>): KeyDraft[] {
  return keyBodies(body).map((row) => {
    const type = (row.type ?? 'string') as KeyDraft['type'];
    const secret = row.secret === '1';
    const values = (row.values ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    // A bool is ticked, not typed. An unticked checkbox posts NOTHING — it is absent from the
    // body rather than present and false — which is exactly what "no default" means here.
    if (type === 'bool') {
      return {
        name: (row.name ?? '').trim(),
        type,
        secret: false,
        values: [],
        description: row.description ?? '',
        default: row.defaultBool === 'true' ? true : null,
      };
    }

    const raw = (row.default ?? '').trim();
    return {
      name: (row.name ?? '').trim(),
      type,
      secret,
      values,
      description: row.description ?? '',
      ...(row.min ? { min: Number(row.min) } : {}),
      ...(row.max ? { max: Number(row.max) } : {}),
      // Blank means no default, which is not the same as the empty string: a key declared with
      // "" would be created holding an empty value rather than nothing.
      default: raw.length === 0 ? null : parseDefault(type, raw),
    };
  });
}

/** A typed default from what was typed. Left as text where it does not parse, so the builder
 *  refuses it with a message about the value rather than silently coercing it. */
function parseDefault(type: KeyDraft['type'], raw: string): unknown {
  if (type === 'int') return Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (type === 'bool') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (type === 'string[]') return raw.split(',').map((entry) => entry.trim());
  return raw;
}

/** What every new environment file starts with: the declared defaults, and never a secret. */
export function defaultsOf(keys: readonly KeyDraft[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.secret) continue;
    if (key.default === null || key.default === undefined) continue;
    defaults[key.name.trim()] = key.default;
  }
  return defaults;
}

export const KEY_DRAFT_TYPES = ['string', 'int', 'bool', 'url', 'string[]'] as const;

/** View models for the shared key-draft rows on Add a product and Add a variable. */
export function keyDraftModels(
  rows: ReadonlyArray<Record<string, string>> | undefined,
  problems: ReadonlyArray<{ key: string; message: string }> = [],
) {
  const about = (key: string) => problems.filter((problem) => problem.key === key);
  const list = rows && rows.length > 0 ? rows : [{}];
  return list.map((row, index) => ({
    index,
    name: row.name ?? '',
    type: row.type ?? '',
    types: KEY_DRAFT_TYPES,
    secret: Boolean(row.secret),
    values: row.values ?? '',
    min: row.min ?? '',
    max: row.max ?? '',
    default: row.default ?? '',
    defaultBool: row.defaultBool ?? '',
    description: row.description ?? '',
    problems: about(row.name ?? ''),
  }));
}
