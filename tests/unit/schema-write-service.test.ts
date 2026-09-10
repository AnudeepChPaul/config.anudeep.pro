import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaDryRun } from '@config/src/schema/schema-dry-run.js';
import { SchemaWriteService } from '@config/src/schema/schema-write-service.js';
import { DBEngine } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { describe, expect, it } from 'vitest';

const loader = new ConfigLoader({
  decrypt: async (_path: string, source: string) => source,
} as never);

describe('SchemaWriteService', () => {
  it('rejects malformed global schemas without writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-schema-write-'));
    const db = new DBEngine(root);
    const service = new SchemaWriteService(db, new SchemaDryRun(loader));

    const result = await service.save('version: 2\nservices: {}');

    expect(result.kind).toBe('invalid');
    expect(await db.read('schema.yaml')).toBeNull();
  });

  it('writes a valid schema after the existing-data dry run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-schema-write-'));
    const db = new DBEngine(root);
    const service = new SchemaWriteService(db, new SchemaDryRun(loader));
    const source = 'version: 1\nservices:\n  web:\n    keys:\n      ENABLED: { type: bool }\n';

    const result = await service.save(source);

    expect(result.kind).toBe('written');
    expect(await db.read('schema.yaml')).toBe(source);
  });

  it('rejects a schema that would invalidate existing data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-schema-write-'));
    const db = new DBEngine(root);
    await db.write({ path: 'config/web/prod.yaml', content: 'ENABLED: wrong\n' });
    const service = new SchemaWriteService(db, new SchemaDryRun(loader));

    const result = await service.save(
      'version: 1\nservices:\n  web:\n    keys:\n      ENABLED: { type: bool }\n',
    );

    expect(result.kind).toBe('invalid');
    expect(await db.read('schema.yaml')).toBeNull();
  });
});
