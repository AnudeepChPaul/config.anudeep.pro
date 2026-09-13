import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MethodLog } from '@config/src/logging.js';
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
      path: 'schema/web.yaml',
      content:
        'version: 1\nkeys:\n  COUNT: {type: int}\n  PASSWORD: {type: string, secret: true}\n',
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
  expect(parse((await db.read('schema/api.yaml')) ?? '').keys).toEqual({ COUNT: { type: 'int' } });
  expect(parse((await db.read('config/api/prod.yaml')) ?? '')).toEqual({ version: 1, COUNT: 1 });
  expect(await db.revision()).toBe('2');
  expect((await operations.createProduct({ ...request, service: 'duplicate' }, actor)).ok).toBe(
    false,
  );
  expect(await db.read('config/duplicate/dev.yaml')).toBeNull();
});
it('adds keys to the schema and writes defaults only into the first environment', async () => {
  const { db, operations } = await fixture();
  const result = await operations.addKeys(
    {
      service: 'web',
      environment: 'dev',
      keys: [
        {
          name: 'SESSION_TTL',
          type: 'int',
          secret: false,
          values: [],
          description: '',
          default: 30,
        },
        {
          name: 'API_TOKEN',
          type: 'string',
          secret: true,
          values: [],
          description: 'token',
          default: null,
        },
      ],
    },
    actor,
  );
  expect(result.ok).toBe(true);
  expect(parse((await db.read('schema/web.yaml')) ?? '').keys).toMatchObject({
    COUNT: { type: 'int' },
    PASSWORD: { type: 'string', secret: true },
    SESSION_TTL: { type: 'int' },
    API_TOKEN: { type: 'string', secret: true },
  });
  expect(parse((await db.read('config/web/dev.yaml')) ?? '')).toEqual({
    version: 3,
    COUNT: 3,
    SESSION_TTL: 30,
  });
  expect(parse((await db.read('config/web/prod.yaml')) ?? '')).toEqual({ version: 4, COUNT: 9 });
  expect(parse((await db.read('config/web/legacy.yaml')) ?? '')).toEqual({ version: 1, COUNT: 10 });
});
it('refuses adding a variable in a higher environment or a name the schema already has', async () => {
  const { db, operations } = await fixture();
  const before = await db.snapshot();
  expect(
    await operations.addKeys(
      {
        service: 'web',
        environment: 'prod',
        keys: [
          {
            name: 'SESSION_TTL',
            type: 'int',
            secret: false,
            values: [],
            description: '',
            default: 30,
          },
        ],
      },
      actor,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'invalid', detail: 'variables can only be added in dev' },
  });
  expect(
    await operations.addKeys(
      {
        service: 'web',
        environment: 'dev',
        keys: [
          {
            name: 'COUNT',
            type: 'int',
            secret: false,
            values: [],
            description: '',
            default: 1,
          },
        ],
      },
      actor,
    ),
  ).toMatchObject({
    ok: false,
    error: { errors: [{ key: 'COUNT', message: "'COUNT' is already declared" }] },
  });
  expect(await db.snapshot()).toEqual(before);
});
it('keeps a retirement mark when adding variables', async () => {
  const { db, operations } = await fixture();
  expect((await operations.setRetiring('web', true, actor)).ok).toBe(true);
  expect(
    (
      await operations.addKeys(
        {
          service: 'web',
          environment: 'dev',
          keys: [
            {
              name: 'REGION',
              type: 'string',
              secret: false,
              values: [],
              description: '',
              default: 'eu',
            },
          ],
        },
        actor,
      )
    ).ok,
  ).toBe(true);
  expect(parse((await db.read('schema/web.yaml')) ?? '')).toMatchObject({
    retiring: true,
    keys: { REGION: { type: 'string' } },
  });
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
  expect(parse((await db.read('schema/web.yaml')) ?? '').keys).toEqual({});
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
  expect(await db.read('schema/web.yaml')).toBeNull();
});
it('refuses retirement when an archive already exists, unless forced', async () => {
  const { db, operations } = await fixture();
  await db.write({ path: 'archived/web.yaml', content: 'version: 1\narchived: {by: old}\n' });
  expect(await operations.setRetiring('web', true, actor)).toMatchObject({
    ok: false,
    error: { code: 'invalid', detail: 'an archive already exists for this product' },
  });
  expect((await db.read('schema/web.yaml')) ?? '').not.toMatch(/retiring: true/);
  expect((await operations.setRetiring('web', true, actor, { force: true })).ok).toBe(true);
  expect((await db.read('schema/web.yaml')) ?? '').toMatch(/retiring: true/);
  expect(await operations.archiveProduct('web', actor)).toMatchObject({
    ok: false,
    error: { detail: 'an archive already exists for this product' },
  });
  expect((await operations.archiveProduct('web', actor, undefined, { force: true })).ok).toBe(true);
  expect(parse((await db.read('archived/web.yaml')) ?? '').archived.by).toBe(actor.email);
  expect(await db.read('schema/web.yaml')).toBeNull();
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
it('saves non-secret edits when a secret is already an empty string', async () => {
  // iam/prod.yaml in the live registry holds SMTP_PASSWORD: "" under a sops block. Re-encrypting
  // that document leaves the empty key unencrypted; the save used to refuse the whole write.
  const { db, operations } = await fixture();
  await db.write({ path: 'config/web/dev.yaml', content: 'version: 2\nCOUNT: 3\nPASSWORD: ""\n' });
  const result = await operations.writeValues(
    { service: 'web', environment: 'dev', changes: { COUNT: 4 } },
    actor,
  );
  expect(result.ok).toBe(true);
  expect(parse((await db.read('config/web/dev.yaml')) ?? '')).toMatchObject({
    COUNT: 4,
    PASSWORD: '',
  });
});
it('still refuses a filled secret that encryption left in plaintext', async () => {
  const { operations } = await fixture();
  expect(
    await operations.writeValues(
      { service: 'web', environment: 'dev', changes: { PASSWORD: 'hunter2' } },
      actor,
    ),
  ).toMatchObject({ ok: false, error: { code: 'secret_not_encrypted' } });
});
it('logs a refused write with field keys, never the submitted values', async () => {
  const warns: Array<{ fields: Record<string, unknown>; event: string }> = [];
  const root = await mkdtemp(join(tmpdir(), 'product-writes-'));
  roots.push(root);
  const db = new DBEngine(root);
  await db.writeMany([
    {
      path: 'services.yaml',
      content: 'version: 1\nservices: [{name: web, uid: 1001, namespaces: [web/dev]}]\n',
    },
    { path: 'environments.yaml', content: 'order: [dev]\n' },
    { path: 'schema/web.yaml', content: 'version: 1\nkeys:\n  COUNT: {type: int, min: 1}\n' },
    { path: 'config/web/dev.yaml', content: 'version: 1\nCOUNT: 3\n' },
  ]);
  const operations = new ProductWriteOperations({
    db,
    loader: new ConfigLoader({ decrypt: async (_path: string, source: string) => source } as never),
    encryptor: { encrypt: async (_path: string, source: string) => source } as never,
    log: {
      warn(fields: object, event: string) {
        warns.push({ fields: fields as Record<string, unknown>, event });
      },
      error(_fields: object, _event: string) {},
    } satisfies Pick<MethodLog, 'warn' | 'error'>,
  });

  const result = await operations.writeValues(
    { service: 'web', environment: 'dev', changes: { COUNT: 0 } },
    actor,
  );

  expect(result.ok).toBe(false);
  expect(warns[0]?.fields.event).toBe('config.write.failed');
  expect(warns[0]?.event).toMatch(/Write failed/);
  expect(warns[0]?.fields.error_keys).toBe('COUNT');
  expect(String(warns[0]?.fields.error_messages)).toContain('must be at least 1');
  expect(JSON.stringify(warns)).not.toContain('"COUNT":0');
});
