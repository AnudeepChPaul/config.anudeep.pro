import type { Namespace } from '../identity/types.js';

/** A 40-character git object id. */
export type Sha = string;

/** One namespace's overrides, exactly as YAML parsed them. Types are preserved. */
export type RawConfig = Readonly<Record<string, unknown>>;

/** Every namespace in the repo, as of one commit. */
export interface ConfigTree {
  readonly commit: Sha;
  readonly namespaces: ReadonlyMap<Namespace, RawConfig>;
}
