import type { Namespace } from '../identity/types.js';
import type { ConfigTree, RawConfig, Sha } from './types.js';

/**
 * What every read is actually served from.
 *
 * The cache exists so that no service read depends on git, GitHub, or the disk being healthy at
 * the moment it asks — reads are a map lookup.
 *
 * It holds **decrypted** values and is therefore deliberately memory-only. Persistence is
 * SnapshotStore's job, and it writes the committed ciphertext rather than this tree.
 */

export class ConfigCache {
  private tree: ConfigTree | null = null;

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
}
