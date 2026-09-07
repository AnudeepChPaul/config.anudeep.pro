import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Namespace } from '../identity/types.js';
import type { ConfigTree, RawConfig, Sha } from './types.js';

/**
 * What every read is actually served from.
 *
 * The cache exists so that no service read depends on git, GitHub, or the disk being healthy at
 * the moment it asks — reads are a map lookup. The disk snapshot exists for one moment only:
 * process start. If the repo is unreadable then, the service serves the last tree it knew
 * rather than nothing at all, which is the difference between a degraded platform and a
 * platform that cannot boot.
 */

interface Snapshot {
  commit: Sha;
  namespaces: Record<Namespace, Record<string, unknown>>;
}

const isSnapshot = (value: unknown): value is Snapshot => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Snapshot>;
  return (
    typeof candidate.commit === 'string' &&
    typeof candidate.namespaces === 'object' &&
    candidate.namespaces !== null &&
    !Array.isArray(candidate.namespaces)
  );
};

export class ConfigCache {
  private tree: ConfigTree | null = null;

  constructor(private readonly snapshotPath: string) {}

  /** The config a service sees, or null when no file defines that namespace at all. */
  get(service: string, environment: string): RawConfig | null {
    return this.tree?.namespaces.get(`${service}/${environment}`) ?? null;
  }

  commit(): Sha | null {
    return this.tree?.commit ?? null;
  }

  /**
   * Replaces the tree wholesale. Never a merge — a deleted key must actually disappear, and
   * dropping a bad override is exactly the operation an incident needs.
   *
   * Values are frozen on the way in so one consumer scribbling on what it was handed cannot
   * change what the next consumer reads.
   */
  reload(tree: ConfigTree): void {
    const namespaces = new Map<Namespace, RawConfig>();
    for (const [namespace, config] of tree.namespaces) {
      namespaces.set(namespace, Object.freeze({ ...config }));
    }
    this.tree = { commit: tree.commit, namespaces };
  }

  /**
   * Writes the snapshot to a temp name and renames it, so a crash mid-write leaves either the
   * old snapshot or the new one and never half of either.
   */
  async persistToDisk(): Promise<void> {
    // Persisting nothing over a good snapshot would turn a failed boot into a lost
    // last-known-good.
    if (!this.tree) return;

    const snapshot: Snapshot = {
      commit: this.tree.commit,
      namespaces: Object.fromEntries(this.tree.namespaces),
    };
    const temp = join(dirname(this.snapshotPath), `.${process.pid}.snapshot.tmp`);

    await writeFile(temp, JSON.stringify(snapshot), 'utf8');
    try {
      await rename(temp, this.snapshotPath);
    } catch (cause) {
      await unlink(temp).catch(() => {});
      throw cause;
    }
  }

  /**
   * Loads the last-known-good snapshot. Returns whether there was one.
   *
   * Absent, truncated and wrong-shaped snapshots are all the same ordinary answer — "no
   * last-known-good" — because none of them is a reason to keep the service down.
   */
  async loadFromDisk(): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.snapshotPath, 'utf8'));
    } catch {
      return false;
    }

    if (!isSnapshot(parsed)) return false;

    this.reload({
      commit: parsed.commit,
      namespaces: new Map(Object.entries(parsed.namespaces)),
    });
    return true;
  }
}
