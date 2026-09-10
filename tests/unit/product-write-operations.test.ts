import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DBEngine } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { ProductWriteOperations } from '@config/src/store/product-write-operations.js';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'product-writes-'));
  roots.push(root);
  const db = new DBEngine(root);
  await db.writeMany([
    {
      path: 'services.yaml',
      content: 'version: 1\nservices: [{name: web, uid: 1001, namespaces: [web/dev, web/prod]}]\n',
    },
    { path: 'environments.yaml', content: 'order: [dev, prod]\n' },
    {
      path: 'schema.yaml',
      content:
        'version: 1\nservices:\n  web:\n    keys:\n      COUNT: {type: int}\n      PASSWORD: {type: string, secret: true}\n',
    },
    { path: 'config/web/dev.yaml', content: 'version: 2\nCOUNT: 3\n' },
    { path: 'config/web/prod.yaml', content: 'version: 4\nCOUNT: 9\n' },
    { path: 'config/web/legacy.yaml', content: 'version: 1\nCOUNT: 10\n' },
  ]);
  const operations = new ProductWriteOperations({
    db,
    loader: new ConfigLoader({ decrypt: async (_path: string, source: string) => source } as never),
    encryptor: { encrypt: async (_path: string, source: string) => source } as never,
  });
  return { db, operations };
}
const actor = { id: 'operator', email: 'operator@example.com' };
it('creates a product atomically and rejects duplicate identities', async () => {
  const { db, operations } = await fixture();
  const request = {
    service: 'api',
    uid: 1002,
    environments: ['dev', 'prod'],
    schema: 'version: 1\nkeys:\n  COUNT: {type: int}\n',
    defaults: { COUNT: 1 },
  };
  expect((await operations.createProduct(request, actor)).ok).toBe(true);
  expect(parse((await db.read('config/api/prod.yaml')) ?? '')).toEqual({ version: 1, COUNT: 1 });
  expect(await db.revision()).toBe('2');
  expect((await operations.createProduct({ ...request, service: 'duplicate' }, actor)).ok).toBe(
    false,
  );
  expect(await db.read('config/duplicate/dev.yaml')).toBeNull();
});
it('promotes selected non-secrets directly and refuses secrets and reversed order', async () => {
  const { db, operations } = await fixture();
  expect(
    (await operations.promote({ service: 'web', from: 'dev', to: 'prod', keys: ['COUNT'] }, actor))
      .ok,
  ).toBe(true);
  expect(parse((await db.read('config/web/prod.yaml')) ?? '')).toEqual({ version: 5, COUNT: 3 });
  const revision = await db.revision();
  expect(
    await operations.promote(
      { service: 'web', from: 'dev', to: 'prod', keys: ['PASSWORD'] },
      actor,
    ),
  ).toMatchObject({
    ok: false,
    error: { detail: 'cannot promote a secret (PASSWORD) — set it directly in prod' },
  });
  expect(
    (await operations.promote({ service: 'web', from: 'prod', to: 'dev', keys: ['COUNT'] }, actor))
      .ok,
  ).toBe(false);
  expect(await db.revision()).toBe(revision);
});
it('deletes from the schema and every stored environment, including undeclared environments', async () => {
  const { db, operations } = await fixture();
  const result = await operations.deleteKeys('web', ['COUNT', 'PASSWORD'], actor);
  expect(result.ok).toBe(true);
  expect(parse((await db.read('schema.yaml')) ?? '').services.web.keys).toEqual({});
  for (const [env, version] of [
    ['dev', 3],
    ['prod', 5],
    ['legacy', 2],
  ])
    expect(parse((await db.read(`config/web/${env}.yaml`)) ?? '')).toEqual({ version });
  expect(await db.revision()).toBe('2');
});
it('retirement changes only the schema; archive preserves ciphertext and removes every live file', async () => {
  const { db, operations } = await fixture();
  expect((await operations.archiveProduct('web', actor)).ok).toBe(false);
  const before = await db.read('config/web/dev.yaml');
  expect((await operations.setRetiring('web', true, actor)).ok).toBe(true);
  expect(await db.read('config/web/dev.yaml')).toBe(before);
  expect((await operations.archiveProduct('web', actor)).ok).toBe(true);
  expect(parse((await db.read('archived/web.yaml')) ?? '').environments.dev).toBe(before);
  expect(await db.read('config/web/legacy.yaml')).toBeNull();
  expect(parse((await db.read('services.yaml')) ?? '').services).toEqual([]);
  expect(parse((await db.read('schema.yaml')) ?? '').services).toEqual({});
});
it('refuses a delete that would leave an invalid document and writes nothing', async () => {
  const { db, operations } = await fixture();
  await db.write({ path: 'config/web/legacy.yaml', content: 'COUNT: 1\nUNKNOWN: invalid\n' });
  const before = await db.snapshot();
  expect(await operations.deleteKeys('web', ['COUNT'], actor)).toMatchObject({
    ok: false,
    error: { code: 'would_orphan' },
  });
  expect(await db.snapshot()).toEqual(before);
});
