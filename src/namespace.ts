import type { Namespace } from './identity/types.js';

/**
 * `<service>/<environment>`. Anything else — a path, a glob, a bare service name, a third
 * segment — is not a namespace.
 *
 * Shared between the grant table and the repository loader on purpose: if the two disagreed
 * about what a namespace is, a grant could be written that no config file can ever match, or a
 * file could be loaded that no grant can ever name.
 */
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

export const isNamespace = (value: string): value is Namespace => NAMESPACE_PATTERN.test(value);
