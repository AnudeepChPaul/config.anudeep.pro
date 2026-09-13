import { err, ok, type Result } from '@config/src/identity/types.js';
import { logCaught } from '@config/src/logging.js';
import { parse as parseYaml } from 'yaml';

export interface FlagDocument {
  readonly version: 1;
  readonly flags: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
}

export interface FlagValidationError {
  readonly key: string;
  readonly message: string;
}

export interface EnvironmentNames {
  has(environment: string): boolean;
}

/** PascalCase identifier: starts with an uppercase letter, then letters or digits. */
const NAME = /^[A-Z][A-Za-z0-9]*$/;

/** Parses and validates the complete plaintext flag document at its file boundary. */
export class FlagValidator {
  constructor(private readonly environments: EnvironmentNames) {}

  validateFile(source: string): Result<FlagDocument, FlagValidationError[]> {
    let parsed: unknown;
    try {
      parsed = parseYaml(source);
    } catch (error) {
      logCaught(error, 'config.flag.yaml.failed', { logger: 'flags.document' });
      return err([{ key: '*', message: 'flags.yaml is not valid YAML' }]);
    }

    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.flags)) {
      return err([{ key: '*', message: 'flags.yaml must contain version: 1 and a flags mapping' }]);
    }

    const errors: FlagValidationError[] = [];
    const flags = new Map<string, ReadonlyMap<string, boolean>>();
    for (const [name, rawValues] of Object.entries(parsed.flags)) {
      if (!NAME.test(name))
        errors.push({ key: name, message: 'flag name must be TitleCase' });
      if (!isRecord(rawValues)) {
        errors.push({ key: name, message: 'flag values must be an environment mapping' });
        continue;
      }
      const values = new Map<string, boolean>();
      for (const [environment, value] of Object.entries(rawValues)) {
        if (!this.environments.has(environment)) {
          errors.push({
            key: `${name}.${environment}`,
            message: `unknown environment '${environment}'`,
          });
        } else if (typeof value !== 'boolean') {
          errors.push({
            key: `${name}.${environment}`,
            message: 'flag value must be true or false',
          });
        } else {
          values.set(environment, value);
        }
      }
      flags.set(name, values);
    }
    return errors.length > 0 ? err(errors) : ok({ version: 1, flags });
  }
}

export class FlagSet {
  constructor(private readonly document: FlagDocument) {}

  names(): readonly string[] {
    return [...this.document.flags.keys()];
  }

  valueOf(name: string, environment: string): boolean {
    return this.document.flags.get(name)?.get(environment) ?? false;
  }

  resolveFor(environment: string): Readonly<Record<string, boolean>> {
    return Object.fromEntries(this.names().map((name) => [name, this.valueOf(name, environment)]));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
