import type { Namespace } from '../identity/types.js';

/** A 40-character git object id. */
export type Sha = string;

/** One namespace's overrides, exactly as YAML parsed them. Types are preserved. */
export type RawConfig = Readonly<Record<string, unknown>>;

/**
 * Every namespace's file text exactly as committed — which means secret values are still
 * encrypted. This is what gets snapshotted to disk, so that plaintext never reaches a volume
 * that is backed up.
 */
export interface ConfigSources {
  readonly commit: Sha;
  readonly sources: ReadonlyMap<Namespace, string>;
}

/** Every namespace in the repo, as of one commit, decrypted and parsed. Memory only. */
export interface ConfigTree {
  readonly commit: Sha;
  readonly namespaces: ReadonlyMap<Namespace, RawConfig>;
}
