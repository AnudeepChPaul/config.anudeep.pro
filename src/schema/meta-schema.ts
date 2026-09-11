import { err, ok, type Result } from '@config/src/identity/types.js';
import { logCaught } from '@config/src/logging.js';
import { SchemaError, SchemaSet } from '@config/src/schema/validator.js';

export interface SchemaMetaError {
  readonly key: string;
  readonly message: string;
}

/** Boundary validator for a global schema document. */
export class SchemaMetaValidator {
  validateFile(source: string): Result<SchemaSet, SchemaMetaError[]> {
    try {
      return ok(SchemaSet.fromDocument(source));
    } catch (cause) {
      logCaught(cause, 'config.schema.meta.failed', { logger: 'schema.meta' });
      const error = cause as Error;
      return err([
        { key: '*', message: error instanceof SchemaError ? error.message : String(cause) },
      ]);
    }
  }
}
