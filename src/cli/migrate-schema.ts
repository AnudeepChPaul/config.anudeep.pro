import { SchemaSet } from '@config/src/schema/validator.js';
import { parse, stringify } from 'yaml';

/** Composes the global schema document without deleting the legacy inputs. */
export function composeGlobalSchema(files: Record<string, string>): string {
  const services: Record<string, unknown> = {};
  for (const [service, source] of Object.entries(files)) {
    const parsed = parse(source) as Record<string, unknown>;
    const { version: _version, ...definition } = parsed;
    SchemaSet.fromFiles({ [service]: source });
    services[service] = definition;
  }
  const document = { version: 1, services };
  SchemaSet.fromDocument(stringify(document));
  return stringify(document);
}
