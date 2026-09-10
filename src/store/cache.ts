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
  private flagsByEnvironment: ReadonlyMap<string, Readonly<Record<string, boolean>>> = new Map();
  private synced: Sha | null = null;
  /** Called after every reload, so a held-open read can answer the moment a change lands. */
  private readonly listeners = new Set<() => void>();

  /** The config a service sees, or null when no file defines that namespace at all. */
  get(service: string, environment: string): RawConfig | null {
    return this.tree?.namespaces.get(`${service}/${environment}`) ?? null;
  }

  commit(): Sha | null {
    return this.tree?.commit ?? null;
  }

  syncedCommit(): Sha | null {
    return this.synced;
  }

  markSynced(commit: Sha): void {
    this.synced = commit;
  }

  flagsFor(environment: string): Readonly<Record<string, boolean>> {
    return this.flagsByEnvironment.get(environment) ?? {};
  }

  /**
   * Replaces the tree wholesale. Never a merge — a deleted key must actually disappear, and
   * dropping a bad override is exactly the operation an incident needs.
   *
   * Values are frozen on the way in so one consumer scribbling on what it was handed cannot
   * change what the next consumer reads.
   */
  reload(
    tree: ConfigTree,
    options: {
      readonly flags?: Readonly<Record<string, boolean>>;
      readonly flagsByEnvironment?: ReadonlyMap<string, Readonly<Record<string, boolean>>>;
      readonly syncedCommit?: Sha | null;
    } = {},
  ): void {
    const namespaces = new Map<Namespace, RawConfig>();
    for (const [namespace, config] of tree.namespaces) {
      namespaces.set(namespace, Object.freeze({ ...config }));
    }
    this.tree = { commit: tree.commit, namespaces };
    this.flagsByEnvironment =
      options.flagsByEnvironment ?? new Map([['', Object.freeze({ ...(options.flags ?? {}) })]]);
    this.synced = options.syncedCommit ?? this.synced;

    for (const listener of [...this.listeners]) {
      // One waiter throwing must not stop the rest from being woken, or a single bad consumer
      // freezes propagation for every service on the host.
      try {
        listener();
      } catch {
        // Nothing useful to do here; the waiter's own timeout will release it.
      }
    }
  }

  /** Registers a waiter. The returned function removes it — always call it, or waiters leak. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
