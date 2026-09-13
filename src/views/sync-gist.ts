import { isMetadataKey } from '@config/src/store/metadata.js';
import type { JournalEntry } from '@config/src/store/write-journal.js';
import { titled } from '@config/src/views/page-frame.js';

export interface SyncGist {
  readonly path: string;
  readonly label: string;
  readonly keys: readonly string[];
  readonly actors: readonly string[];
  readonly writes: number;
  readonly lastAt: string;
}

const placeLabel = (path: string): string => {
  const config = path.match(/^config\/([^/]+)\/([^/]+)\.yaml$/);
  if (config?.[1] && config[2]) return `${titled(config[1])} · ${titled(config[2])}`;
  const schema = path.match(/^schema\/([^/]+)\.yaml$/);
  if (schema?.[1]) return `${titled(schema[1])} schema`;
  const archived = path.match(/^archived\/([^/]+)\.yaml$/);
  if (archived?.[1]) return `Archived ${titled(archived[1])}`;
  if (path === 'flags.yaml') return 'Features';
  if (path === 'services.yaml') return 'Registry';
  if (path === 'environments.yaml') return 'Environments';
  return path;
};

export const productOfPath = (path: string): string | undefined =>
  path.match(/^config\/([^/]+)\//)?.[1] ??
  path.match(/^schema\/([^/]+)\.yaml$/)?.[1] ??
  path.match(/^archived\/([^/]+)\.yaml$/)?.[1];

const keysOf = (entry: JournalEntry): string[] => entry.keys.filter((key) => !isMetadataKey(key));

/** Collapse journal rows into one gist per file: keys, who wrote, how many writes. */
export function gistFromJournal(entries: readonly JournalEntry[]): readonly SyncGist[] {
  const grouped = new Map<
    string,
    { keys: Set<string>; actors: Set<string>; writes: number; lastAt: string }
  >();
  for (const entry of entries) {
    const held = grouped.get(entry.path) ?? {
      keys: new Set(),
      actors: new Set(),
      writes: 0,
      lastAt: entry.timestamp ?? '',
    };
    for (const key of keysOf(entry)) held.keys.add(key);
    held.actors.add(entry.actor);
    held.writes += 1;
    if (entry.timestamp && entry.timestamp > held.lastAt) held.lastAt = entry.timestamp;
    grouped.set(entry.path, held);
  }
  return [...grouped.entries()].map(([path, held]) => ({
    path,
    label: placeLabel(path),
    keys: [...held.keys].sort((left, right) => left.localeCompare(right)),
    actors: [...held.actors].sort((left, right) => left.localeCompare(right)),
    writes: held.writes,
    lastAt: held.lastAt,
  }));
}

/** Registry adds and archives, then leftover file gists. Retiring products stay off this list. */
export function syncRowsFromJournal(
  entries: readonly JournalEntry[],
  retiring: ReadonlySet<string>,
): {
  retiring: readonly string[];
  added: readonly string[];
  archived: readonly string[];
  configsOf: Readonly<Record<string, readonly SyncGist[]>>;
  gists: readonly SyncGist[];
} {
  const all = gistFromJournal(entries);
  const retiringProducts = new Set(retiring);
  for (const gist of all) {
    const schemaProduct = gist.path.match(/^schema\/([^/]+)\.yaml$/)?.[1];
    if (schemaProduct && gist.keys.includes('retiring')) retiringProducts.add(schemaProduct);
  }
  const retiringList = [...retiringProducts].sort((left, right) => left.localeCompare(right));
  const archived = [
    ...new Set(
      all
        .map((gist) => gist.path.match(/^archived\/([^/]+)\.yaml$/)?.[1])
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const archivedSet = new Set(archived);
  const added = [
    ...new Set(all.find((gist) => gist.path === 'services.yaml')?.keys ?? []),
  ]
    .filter((name) => !retiringProducts.has(name) && !archivedSet.has(name))
    .sort((left, right) => left.localeCompare(right));
  const skip = new Set([
    ...[...retiringProducts].filter((name) => !archivedSet.has(name)),
    ...added,
    ...archived,
  ]);
  const configsOf: Record<string, SyncGist[]> = {};
  for (const name of added) {
    configsOf[name] = all.filter((gist) => gist.path.startsWith(`config/${name}/`));
  }
  return {
    retiring: retiringList,
    added,
    archived,
    configsOf,
    gists: all.filter((gist) => {
      if (gist.path === 'services.yaml') return false;
      const product = productOfPath(gist.path);
      return !product || !skip.has(product);
    }),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatGistWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hours}:${minutes} UTC`;
}
