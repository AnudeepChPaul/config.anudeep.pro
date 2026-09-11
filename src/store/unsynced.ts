import { isMetadataKey } from '@config/src/store/metadata.js';
import type { JournalEntry } from '@config/src/store/write-journal.js';

/** Unique unsynced config keys per product, from writes that have not reached Git. */
export function unsyncedKeyCounts(entries: readonly JournalEntry[]): ReadonlyMap<string, number> {
  const keys = new Map<string, Set<string>>();
  for (const entry of entries) {
    const service = entry.path.match(/^config\/([^/]+)\//)?.[1];
    if (!service) continue;
    const held = keys.get(service) ?? new Set<string>();
    for (const key of entry.keys) if (!isMetadataKey(key)) held.add(key);
    keys.set(service, held);
  }
  return new Map([...keys].map(([service, held]) => [service, held.size]));
}

export const unsyncedTotal = (counts: ReadonlyMap<string, number>): number =>
  [...counts.values()].reduce((sum, count) => sum + count, 0);
