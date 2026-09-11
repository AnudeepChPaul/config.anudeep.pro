import { err, ok, type Result } from '@config/src/identity/types.js';
import { logCaught, logged } from '@config/src/logging.js';
import type { SchemaSet, ValidationError } from '@config/src/schema/validator.js';
import type { ConfigLoader } from '@config/src/store/loader.js';

/** Validates a candidate schema against every currently stored configuration file. */
export class SchemaDryRun {
  constructor(private readonly loader: ConfigLoader) {}

  async validateExisting(
    schema: SchemaSet,
    sources: ReadonlyMap<string, string>,
  ): Promise<Result<void, ValidationError[]>> {
    return logged(undefined, 'config.schema.dry-run', { logger: 'schema.dry-run' }, async () => {
    const errors: ValidationError[] = [];
    for (const [namespace, source] of sources) {
      const [service = '', environment = ''] = namespace.split('/');
      try {
        const config = await this.loader.resolveOne(namespace, source);
        const result = schema.validate(service, config);
        if (!result.ok) {
          errors.push(
            ...result.error.map((problem) => ({
              key: `${namespace}.${problem.key}`,
              message: problem.message,
            })),
          );
        }
      } catch (error) {
        logCaught(error, 'config.schema.dry-run.failed', { logger: 'schema.dry-run', namespace });
        errors.push({
          key: namespace,
          message: `could not validate ${service}/${environment}: ${(error as Error).message}`,
        });
      }
    }
    return errors.length > 0 ? err(errors) : ok(undefined);
    });
  }
}
