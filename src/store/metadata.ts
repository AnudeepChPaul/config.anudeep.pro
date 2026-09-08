/**
 * The parts of a namespace document that are not configuration.
 *
 * Two things live beside the keys in a config file: the `sops` block, which records how the file
 * is encrypted, and `version`, a revision counter. Neither is in the schema, neither is a key an
 * operator sets, and neither is served to a consuming service — so both have to be recognised in
 * one place rather than special-cased wherever a document is read.
 */

export const VERSION_KEY = 'version';

const METADATA_KEYS = new Set<string>([VERSION_KEY, 'sops']);

export const isMetadataKey = (key: string): boolean => METADATA_KEYS.has(key);

/**
 * The counter a document carries, or 0 for one that has never carried it.
 *
 * Anything that is not a whole, non-negative number reads as 0. A hand-edited "v3" or "3.1"
 * must not become NaN and then overwrite a real counter with garbage — treating it as absent
 * means the next save writes a number again.
 */
export function versionOf(document: Record<string, unknown>): number {
  const raw = document[VERSION_KEY];
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

/** What the next revision of this document should be numbered. */
export const bumpedVersion = (document: Record<string, unknown>): number => versionOf(document) + 1;

/** The document without its metadata: what the schema checks and what a service is served. */
export function configOnly<T extends Record<string, unknown>>(document: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!isMetadataKey(key)) out[key] = value;
  }
  return out as T;
}
