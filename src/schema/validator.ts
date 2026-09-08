import { parse as parseYaml } from 'yaml';
import { err, ok, type Result } from '../identity/types.js';
import { isMetadataKey } from '../store/metadata.js';
import type { RawConfig } from '../store/types.js';

/**
 * Typed config keys, checked at write time.
 *
 * What matters here is *when* this runs. Without it a typo or a wrong type surfaces at some
 * service's next boot — and since config is edited during incidents, the change made to fix an
 * outage becomes the thing that extends it. Validation at save puts the error in front of the
 * operator while they are still looking at the screen.
 */

export type KeyType = 'string' | 'int' | 'bool' | 'enum' | 'url' | 'string[]';

const KEY_TYPES: readonly KeyType[] = ['string', 'int', 'bool', 'enum', 'url', 'string[]'];

/** A value SOPS has already encrypted. Recognised, never decrypted, by this module. */
const SOPS_ENCRYPTED = /^ENC\[AES256_GCM,/;

/** Schemes a URL-typed key may use. `file:` parses fine and must never be a webhook target. */
const URL_SCHEMES = new Set(['http:', 'https:']);

export interface KeyDefinition {
  readonly type: KeyType;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly secret: boolean;
  readonly description?: string;
}

export interface ValidationError {
  readonly key: string;
  readonly message: string;
}

export class SchemaError extends Error {}

const fail = (key: string, message: string): ValidationError => ({ key, message });

export class SchemaSet {
  private constructor(
    private readonly services: ReadonlyMap<string, ReadonlyMap<string, KeyDefinition>>,
  ) {}

  /** `{ iam: <contents of schema/iam.yaml>, ... }`. Throws on a schema that could never be met. */
  static fromFiles(files: Record<string, string>): SchemaSet {
    const services = new Map<string, ReadonlyMap<string, KeyDefinition>>();
    for (const [service, source] of Object.entries(files)) {
      services.set(service, parseSchema(service, source));
    }
    return new SchemaSet(services);
  }

  /**
   * The declared keys for a service, so the UI can render a form the schema describes rather
   * than guessing types from whatever values happen to be set.
   */
  definitionsFor(service: string): ReadonlyMap<string, KeyDefinition> {
    return this.services.get(service) ?? new Map();
  }

  /** Whether this key must be SOPS-encrypted before it is committed. */
  isSecret(service: string, key: string): boolean {
    return this.services.get(service)?.get(key)?.secret ?? false;
  }

  /**
   * Every problem at once — a save that reports one error per round trip is a save that takes
   * five attempts during an incident.
   *
   * An absent key is never an error: the registry is an override channel, and every key has a
   * compiled-in default in the consuming service.
   */
  validate(service: string, config: RawConfig): Result<void, ValidationError[]> {
    const keys = this.services.get(service);
    if (!keys) {
      // Letting an unknown service through unchecked would make the schema optional in
      // practice: forget the file and validation silently stops happening.
      return err([fail('*', `no schema is defined for service '${service}'`)]);
    }

    const errors: ValidationError[] = [];
    for (const [key, value] of Object.entries(config)) {
      // `sops` and `version` are metadata the file carries about itself. Checking them against
      // the schema would fail every document that has them, and the first fix anyone would
      // reach for is deleting the thing that failed.
      if (isMetadataKey(key)) continue;

      const definition = keys.get(key);
      if (!definition) {
        // Otherwise a mistyped key writes cleanly, the service reads its default, and nothing
        // reports that the change had no effect.
        errors.push(fail(key, `'${key}' is not a key in the ${service} schema`));
        continue;
      }
      const problem = checkValue(key, definition, value);
      if (problem) errors.push(problem);
    }

    return errors.length ? err(errors) : ok(undefined);
  }
}

function checkValue(
  key: string,
  definition: KeyDefinition,
  value: unknown,
): ValidationError | null {
  if (typeof value === 'string' && SOPS_ENCRYPTED.test(value)) {
    // Validating the repository as committed sees ciphertext, so a secret key must not be
    // required to look like its plaintext. In a non-secret key the same ciphertext means either
    // the schema or `.sops.yaml` is wrong, and neither is safe to serve.
    return definition.secret
      ? null
      : fail(key, `'${key}' holds an encrypted value but is not marked secret in the schema`);
  }

  if (value === null || value === undefined) {
    // Removing an override is deleting the key. A null would make the tree carry a value that
    // means "no value", which every consumer would then have to handle.
    return fail(key, `'${key}' cannot be null — delete the key to remove the override`);
  }

  switch (definition.type) {
    case 'string':
      return typeof value === 'string' ? null : fail(key, `'${key}' must be a string`);

    case 'bool':
      // YAML produces a real boolean; a string here means someone typed "true" into a form, and
      // the consuming service would read any non-empty string as truthy.
      return typeof value === 'boolean' ? null : fail(key, `'${key}' must be true or false`);

    case 'int': {
      if (!Number.isInteger(value)) return fail(key, `'${key}' must be a whole number`);
      const n = value as number;
      if (definition.min !== undefined && n < definition.min) {
        return fail(key, `'${key}' must be at least ${definition.min}`);
      }
      if (definition.max !== undefined && n > definition.max) {
        return fail(key, `'${key}' must be at most ${definition.max}`);
      }
      return null;
    }

    case 'enum': {
      const values = definition.values ?? [];
      // The operator is mid-incident: the message has to be enough to fix the value without
      // opening the schema file.
      return typeof value === 'string' && values.includes(value)
        ? null
        : fail(key, `'${key}' must be one of: ${values.join(', ')}`);
    }

    case 'url': {
      if (typeof value !== 'string') return fail(key, `'${key}' must be a URL`);
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return fail(key, `'${key}' must be a valid URL`);
      }
      return URL_SCHEMES.has(parsed.protocol)
        ? null
        : fail(key, `'${key}' must be an http or https URL`);
    }

    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? null
        : fail(key, `'${key}' must be a list of strings`);
  }
}

function parseSchema(service: string, source: string): ReadonlyMap<string, KeyDefinition> {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (cause) {
    throw new SchemaError(`schema/${service}.yaml is not valid YAML`, { cause });
  }

  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof keys !== 'object' ||
    keys === null ||
    Array.isArray(keys)
  ) {
    throw new SchemaError(`schema/${service}.yaml must be a mapping with a 'keys' mapping`);
  }

  const definitions = new Map<string, KeyDefinition>();
  for (const [key, raw] of Object.entries(keys as Record<string, unknown>)) {
    definitions.set(key, parseKey(service, key, raw));
  }
  return definitions;
}

function parseKey(service: string, key: string, raw: unknown): KeyDefinition {
  const where = `schema/${service}.yaml: '${key}'`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaError(`${where} must be a mapping describing the key`);
  }

  const { type, values, min, max, secret, description } = raw as Record<string, unknown>;
  if (typeof type !== 'string' || !KEY_TYPES.includes(type as KeyType)) {
    throw new SchemaError(`${where} declares unsupported type '${String(type)}'`);
  }

  // A schema no value can satisfy is worse than no schema: every future write to the key fails
  // with a message about the value rather than about the schema.
  if (type === 'enum' && (!Array.isArray(values) || values.length === 0)) {
    throw new SchemaError(`${where} is an enum and must list at least one permitted value`);
  }
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    throw new SchemaError(`${where} has min ${min} greater than max ${max}`);
  }

  return {
    type: type as KeyType,
    ...(Array.isArray(values) ? { values: values.map(String) } : {}),
    ...(typeof min === 'number' ? { min } : {}),
    ...(typeof max === 'number' ? { max } : {}),
    secret: secret === true,
    ...(typeof description === 'string' ? { description } : {}),
  };
}
