import { SchemaMetaValidator } from '@config/src/schema/meta-schema.js';
import type { SchemaDryRun } from '@config/src/schema/schema-dry-run.js';
import type { DBEngine } from '@config/src/store/data-layer.js';

export type SchemaWriteResult =
  | { readonly kind: 'written'; readonly revision: string; readonly etag: string }
  | { readonly kind: 'unchanged'; readonly revision: string; readonly etag: string }
  | { readonly kind: 'conflict'; readonly currentEtag: string; readonly revision: string }
  | { readonly kind: 'invalid'; readonly errors: readonly { key: string; message: string }[] };

/** Validates a global schema and all existing data before writing it to the database. */
export class SchemaWriteService {
  private readonly meta = new SchemaMetaValidator();

  constructor(
    private readonly db: DBEngine,
    private readonly dryRun: SchemaDryRun,
  ) {}

  async save(source: string, expectedEtag?: string): Promise<SchemaWriteResult> {
    const parsed = this.meta.validateFile(source);
    if (!parsed.ok) return { kind: 'invalid', errors: parsed.error };
    const configSources = new Map<string, string>();
    for (const [path, content] of await this.db.readAll('config')) {
      if (!path.endsWith('.yaml')) continue;
      const namespace = path.slice('config/'.length, -'.yaml'.length);
      if (namespace.split('/').length === 2) configSources.set(namespace, content);
    }
    const existing = await this.dryRun.validateExisting(parsed.value, configSources);
    if (!existing.ok) return { kind: 'invalid', errors: existing.error };
    const result = await this.db.write({ path: 'schema.yaml', content: source, expectedEtag });
    switch (result.kind) {
      case 'written':
      case 'unchanged':
        return result;
      case 'conflict':
        return { kind: 'conflict', currentEtag: result.actual ?? '', revision: result.revision };
      case 'invalid':
        return { kind: 'invalid', errors: result.errors };
    }
  }
}
