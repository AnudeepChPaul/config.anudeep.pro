import { parse as parseYaml } from 'yaml';
import type { Namespace } from '../identity/types.js';
import type { SopsDecryptor } from './sops.js';
import type { ConfigSources, ConfigTree, RawConfig } from './types.js';

/**
 * Turns committed file text into the tree that gets served.
 *
 * Decryption then parsing, in that order and only in that order. A SOPS document is not the
 * document it will become: parsing first would type-check ciphertext and would leave the `sops`
 * metadata block sitting among the config keys, where the schema validator would reject it.
 */

export class ConfigLoadError extends Error {}

export class ConfigLoader {
  constructor(private readonly decryptor: SopsDecryptor) {}

  async resolve(sources: ConfigSources): Promise<ConfigTree> {
    const namespaces = new Map<Namespace, RawConfig>();

    for (const [namespace, source] of sources.sources) {
      // The path is reconstructed for error messages: an operator reading "could not decrypt
      // iam/prod" has to work out which file that is.
      const path = `config/${namespace}.yaml`;
      // A namespace that cannot be decrypted fails the whole load. Serving the rest would boot
      // a service that looks healthy while silently using a compiled-in default for a secret it
      // believes it was given.
      const plaintext = await this.decryptor.decrypt(path, source);
      namespaces.set(namespace, parseConfig(path, plaintext));
    }

    return { commit: sources.commit, namespaces };
  }
}

function parseConfig(path: string, source: string): RawConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (cause) {
    throw new ConfigLoadError(`${path} is not valid YAML`, { cause });
  }

  // An empty file is a namespace that overrides nothing — different from an absent one.
  if (parsed === null || parsed === undefined) return Object.freeze({});

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigLoadError(`${path} must be a mapping of config keys to values`);
  }

  return Object.freeze(parsed as Record<string, unknown>);
}
