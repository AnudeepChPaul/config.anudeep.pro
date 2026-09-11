import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DBEngine } from '@config/src/store/data-layer.js';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
it('refuses a changed environment collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preconditions-'));
  roots.push(root);
  const db = new DBEngine(root);
  await db.write({ path: 'config/web/new.yaml', content: 'COUNT: 1' });
  const result = await db.writeMany(
    [{ path: 'schema.yaml', content: 'keys: {}' }],
    [],
    [{ path: 'config/web', files: [] }],
  );
  expect(result.kind).toBe('conflict');
  expect(await db.read('schema.yaml')).toBeNull();
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('checks read dependencies without writing them or changing the revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preconditions-'));
  roots.push(root);
  const db = new DBEngine(root);
  await db.write({ path: 'schema.yaml', content: 'old' });
  const expectedEtag = await db.etag('schema.yaml');
  await db.write({ path: 'schema.yaml', content: 'new' });
  const result = await db.writeMany(
    [{ path: 'config/web/dev.yaml', content: 'value' }],
    [{ path: 'schema.yaml', expectedEtag }],
  );
  expect(result.kind).toBe('conflict');
  expect(await db.read('config/web/dev.yaml')).toBeNull();
  expect(await db.revision()).toBe('2');
});
