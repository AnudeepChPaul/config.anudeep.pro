import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Namespace } from '../identity/types.js';
import type { ConfigSources } from './types.js';

/**
 * The last-known-good snapshot, on disk.
 *
 * It exists for one moment: process start. If the repo is unreadable then — a corrupt clone, a
 * volume that came back empty — the service serves the last tree it knew instead of nothing,
 * which is the difference between a degraded platform and one that cannot boot.
 *
 * **It stores the file text exactly as committed, so secret values are still encrypted.** The
 * decrypted tree lives only in memory. Snapshotting the resolved values would be far simpler
 * and would write every secret in plaintext onto whatever backs this volume up, which is the
 * one thing encrypting them at rest was for. Restoring therefore needs the age key at boot —
 * already true, since nothing can be decrypted without it anyway.
 */

interface SnapshotFile {
  commit: string;
  sources: Record<Namespace, string>;
}

const isSnapshotFile = (value: unknown): value is SnapshotFile => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SnapshotFile>;
  if (typeof candidate.commit !== 'string') return false;
  if (typeof candidate.sources !== 'object' || candidate.sources === null) return false;
  if (Array.isArray(candidate.sources)) return false;
  // Every value must be file text. A snapshot holding parsed objects is one written by an older
  // build that persisted the resolved tree, and its secrets would already be plaintext.
  return Object.values(candidate.sources).every((source) => typeof source === 'string');
};

export class SnapshotStore {
  constructor(private readonly path: string) {}

  /** Writes to a temp name and renames, so a crash leaves the old snapshot or the new one. */
  async save(sources: ConfigSources): Promise<void> {
    const file: SnapshotFile = {
      commit: sources.commit,
      sources: Object.fromEntries(sources.sources),
    };
    const temp = join(dirname(this.path), `.${process.pid}.snapshot.tmp`);

    await writeFile(temp, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temp, this.path);
    } catch (cause) {
      await unlink(temp).catch(() => {});
      throw cause;
    }
  }

  /**
   * The stored sources, or null when there is no usable snapshot.
   *
   * Absent, truncated and wrong-shaped files are all the same ordinary answer — "no
   * last-known-good" — because none of them is a reason to keep the service down.
   */
  async load(): Promise<ConfigSources | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      return null;
    }

    if (!isSnapshotFile(parsed)) return null;

    return { commit: parsed.commit, sources: new Map(Object.entries(parsed.sources)) };
  }
}
