import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerUiRoutes } from '@config/src/routes/ui.js';
import { DBEngine, etagFor } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { ProductWriteOperations } from '@config/src/store/product-write-operations.js';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appWithProduct() {
  const root = await mkdtemp(join(tmpdir(), 'add-keys-route-'));
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
  await db.write({ path: 'environments.yaml', content: 'order: [dev, prod]\n' });
  await operations.createProduct(
    {
      service: 'web',
      uid: 1001,
      environments: ['dev', 'prod'],
      schema: 'version: 1\nkeys:\n  COUNT: {type: int}\n',
      defaults: { COUNT: 1 },
    },
    { email: 'test@example.com', id: 'test' },
  );
  const app = Fastify({ logger: false });
  await app.register(formbody);
  registerUiRoutes(app, { db, loader, operations });
  return { app, db };
}

it('shows Add a variable only on the first environment and writes defaults only there', async () => {
  const { app, db } = await appWithProduct();
  try {
    const lower = await app.inject('/p/web?env=dev');
    expect(lower.body).toContain('id="add-keys"');
    expect(lower.body).toContain('+ Add variable');
    const higher = await app.inject('/p/web?env=prod');
    expect(higher.body).not.toContain('id="add-keys"');
    const source = (await db.read('config/web/dev.yaml')) ?? '';
    const added = await app.inject({
      method: 'POST',
      url: '/p/web/add-keys',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'hx-request': 'true',
      },
      payload: new URLSearchParams({
        environment: 'dev',
        etag: etagFor(source),
        'key.0.name': 'SESSION_TTL',
        'key.0.type': 'int',
        'key.0.default': '30',
      }).toString(),
    });
    expect(added.statusCode).toBe(200);
    expect(added.body).toContain('Added 1 variable. Live now.');
    expect(added.body).toContain('SESSION_TTL');
    expect(parse((await db.read('config/web/dev.yaml')) ?? '')).toMatchObject({
      COUNT: 1,
      SESSION_TTL: 30,
    });
    expect(parse((await db.read('config/web/prod.yaml')) ?? '')).toEqual({
      version: 1,
      COUNT: 1,
    });
  } finally {
    await app.close();
  }
});

it('round-trips a blank row without writing when Add a variable posts', async () => {
  const { app, db } = await appWithProduct();
  try {
    const before = await db.snapshot();
    const roundTrip = await app.inject({
      method: 'POST',
      url: '/p/web/add-keys',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'hx-request': 'true',
      },
      payload: new URLSearchParams({
        environment: 'dev',
        intent: 'add-key',
        'key.0.name': 'SESSION_TTL',
        'key.0.type': 'int',
      }).toString(),
    });
    expect(roundTrip.statusCode).toBe(200);
    expect(roundTrip.body).toContain('name="key.1.name"');
    expect(await db.snapshot()).toEqual(before);
  } finally {
    await app.close();
  }
});
