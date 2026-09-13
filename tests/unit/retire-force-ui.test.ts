import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerUiRoutes } from '@config/src/routes/ui.js';
import { DBEngine } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import {
  ARCHIVE_ALREADY_EXISTS,
  ProductWriteOperations,
  productBase,
} from '@config/src/store/product-write-operations.js';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const confirmed = (fields: Array<[string, string]>) =>
  new URLSearchParams([...fields, ['confirm', 'yes']]).toString();

async function appWithArchive() {
  const root = await mkdtemp(join(tmpdir(), 'retire-force-'));
  roots.push(root);
  const db = new DBEngine(root);
  const loader = new ConfigLoader({
    decrypt: async (_path: string, source: string) => source,
  } as never);
  const operations = new ProductWriteOperations({
    db,
    loader,
    encryptor: { encrypt: async (_path: string, source: string) => source } as never,
  });
  await db.write({ path: 'environments.yaml', content: 'order: [dev]\n' });
  await operations.createProduct(
    {
      service: 'web',
      uid: 1001,
      environments: ['dev'],
      schema: 'version: 1\nkeys:\n  COUNT: {type: int}\n',
      defaults: { COUNT: 1 },
    },
    { email: 'test@example.com', id: 'test' },
  );
  await db.write({ path: 'archived/web.yaml', content: 'version: 1\narchived: {by: previous}\n' });
  const app = Fastify({ logger: false });
  await app.register(formbody);
  registerUiRoutes(app, { db, loader, operations });
  await app.ready();
  return { app, db };
}

it('asks to retire inline on the product page instead of a confirmation route', async () => {
  const { app } = await appWithArchive();
  const asked = await app.inject({
    method: 'POST',
    url: '/p/web/retire',
    payload: new URLSearchParams({ retiring: 'true' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(asked.statusCode).toBe(200);
  expect(asked.body).toContain('class="retire-ask"');
  expect(asked.body).toContain('Yes, continue');
  expect(asked.body).toContain('name="key.COUNT"');
  expect(asked.body).not.toContain('<h1>Retire web?</h1>');
  await app.close();
});

it('asks to archive inline on the retiring list instead of a confirmation route', async () => {
  const { app, db } = await appWithArchive();
  await app.inject({
    method: 'POST',
    url: '/p/web/retire',
    payload: confirmed([
      ['retiring', 'true'],
      ['force', 'yes'],
    ]),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const asked = await app.inject({
    method: 'POST',
    url: '/p/web/archive',
    payload: new URLSearchParams().toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(asked.statusCode).toBe(200);
  expect(asked.headers['hx-push-url']).toBe('/p/retiring');
  expect(asked.body).toContain('class="archive-ask"');
  expect(asked.body).toContain('Yes, continue');
  expect(asked.body).toContain('name="base"');
  expect(asked.body).not.toContain('<h1>Archive web?</h1>');
  expect(parse((await db.read('schema/web.yaml')) ?? '')).toMatchObject({ retiring: true });
  await app.close();
});

it('shows the archive-exists error in the page, not as JSON', async () => {
  const { app } = await appWithArchive();
  const response = await app.inject({
    method: 'POST',
    url: '/p/web/retire',
    payload: confirmed([['retiring', 'true']]),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(response.statusCode).toBe(422);
  expect(response.headers['content-type']).toMatch(/html/);
  expect(response.body).toContain(ARCHIVE_ALREADY_EXISTS);
  expect(response.body).toContain('Force retire anyway?');
  expect(response.body).toContain('class="retire-ask"');
  expect(response.body).toContain('Cancel');
  expect(response.body).not.toContain('<h1>Retire web?</h1>');
  expect(response.body).not.toMatch(/^\s*\{/);
  await app.close();
});

it('force-retires despite an existing archive', async () => {
  const { app, db } = await appWithArchive();
  const response = await app.inject({
    method: 'POST',
    url: '/p/web/retire',
    payload: confirmed([
      ['retiring', 'true'],
      ['force', 'yes'],
    ]),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(response.statusCode).toBe(303);
  expect((await db.read('schema/web.yaml')) ?? '').toMatch(/retiring: true/);
  await app.close();
});

it('cancel leaves the product unretired', async () => {
  const { app, db } = await appWithArchive();
  const response = await app.inject({
    method: 'POST',
    url: '/p/web/retire',
    payload: new URLSearchParams({ retiring: 'false' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(response.statusCode).toBe(303);
  expect((await db.read('schema/web.yaml')) ?? '').not.toMatch(/retiring: true/);
  await app.close();
});

it('force-archives over the existing file', async () => {
  const { app, db } = await appWithArchive();
  await app.inject({
    method: 'POST',
    url: '/p/web/retire',
    payload: confirmed([
      ['retiring', 'true'],
      ['force', 'yes'],
    ]),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const base = productBase((await db.snapshot()).files, 'web');
  const blocked = await app.inject({
    method: 'POST',
    url: '/p/web/archive',
    payload: confirmed([['base', base]]),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(blocked.statusCode).toBe(422);
  expect(blocked.body).toContain('Force retire anyway?');
  expect(blocked.body).toContain('class="archive-ask"');
  expect(blocked.body).toContain('Retiring');
  expect(blocked.body).not.toContain('Archive web?');
  const forced = await app.inject({
    method: 'POST',
    url: '/p/web/archive',
    payload: confirmed([
      ['force', 'yes'],
      ['base', base],
    ]),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(forced.statusCode).toBe(303);
  expect(parse((await db.read('archived/web.yaml')) ?? '').archived.by).toBe(
    'unauthenticated@localhost',
  );
  expect(await db.read('schema/web.yaml')).toBeNull();
  await app.close();
});
