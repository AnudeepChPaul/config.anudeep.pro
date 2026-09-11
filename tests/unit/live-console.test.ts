import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerUiRoutes as registerLiveUiRoutes } from '@config/src/routes/ui.js';
import { DBEngine } from '@config/src/store/data-layer.js';
import { ConfigLoader } from '@config/src/store/loader.js';
import { ProductWriteOperations } from '@config/src/store/product-write-operations.js';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { visible } from '../helpers.js';

it('saves live, keeps stale edits on 409, and confirms the true delete scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-console-'));
  const db = new DBEngine(root);
  const loader = new ConfigLoader({
    decrypt: async (_path: string, source: string) => source,
  } as never);
  const operations = new ProductWriteOperations({
    db,
    loader,
    encryptor: { encrypt: async (_path: string, source: string) => source } as never,
  });
  await db.write({ path: 'environments.yaml', content: 'order: [dev, prod]' });
  await operations.createProduct(
    {
      service: 'web',
      uid: 1001,
      environments: ['dev', 'prod'],
      schema: 'version: 1\nkeys:\n  COUNT: {type: int}\n  PASSWORD: {type: string, secret: true}',
      defaults: { COUNT: 1 },
    },
    { email: 'test@example.com', id: 'test' },
  );
  await db.write({ path: 'config/web/legacy.yaml', content: 'COUNT: 7' });
  const app = Fastify();
  await app.register(formbody);
  registerLiveUiRoutes(app, { db, loader, operations });
  try {
    const page = await app.inject('/p/web?env=dev');
    expect(page.statusCode).toBe(200);
    // AC8: no route, screen or notice refers to drafts or publishing, asserted over what a
    // reader actually sees.
    expect(visible(page.body)).not.toMatch(/draft|publish/i);
    const etag = await db.etag('config/web/dev.yaml');
    const saved = await app.inject({
      method: 'POST',
      url: '/p/web/dev',
      payload: { 'key.COUNT': '2', etag },
      headers: { 'hx-request': 'true' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain('Live now in web/dev');
    const conflict = await app.inject({
      method: 'POST',
      url: '/p/web/dev',
      payload: { 'key.COUNT': '3', etag },
      headers: { 'hx-request': 'true' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toContain('value="3"');
    const confirmation = await app.inject({
      method: 'POST',
      url: '/p/web/delete-keys',
      payload: { select: 'COUNT', environment: 'dev' },
    });
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.body).toContain('legacy');
    expect(confirmation.body).toContain('COUNT');
    expect(await db.read('config/web/dev.yaml')).toContain('COUNT: 2');
    expect((await app.inject('/drafts')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/publish' })).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
