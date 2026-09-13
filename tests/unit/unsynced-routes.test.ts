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

it('shows saved unsynced diffs against the last Git copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unsynced-routes-'));
  const db = new DBEngine(root);
  const loader = new ConfigLoader({
    decrypt: async (_path: string, source: string) => source,
  } as never);
  const operations = new ProductWriteOperations({
    db,
    loader,
    encryptor: { encrypt: async (_path: string, source: string) => source } as never,
  });
  await db.write({ path: 'environments.yaml', content: 'order: [dev]' });
  await operations.createProduct(
    {
      service: 'web',
      uid: 1001,
      environments: ['dev'],
      schema: 'version: 1\nkeys:\n  COUNT: {type: int}',
      defaults: { COUNT: 2 },
    },
    { email: 'test@example.com', id: 'test' },
  );
  const app = Fastify();
  await app.register(formbody);
  registerLiveUiRoutes(app, {
    db,
    loader,
    operations,
    pendingSync: async () => ({
      ready: true,
      entries: [
        {
          actor: 'test@example.com',
          path: 'config/web/dev.yaml',
          keys: ['COUNT'],
          revision: '1',
          timestamp: '2026-09-11T00:00:00.000Z',
        },
      ],
      unpushed: [],
    }),
    readSynced: async () => 'COUNT: 1\n',
    syncScheduler: {
      syncNow: async () => ({ kind: 'clean' as const, files: [] }),
      isAutoSync: () => false,
      setAutoSync: () => {},
    },
  });
  try {
    const list = await app.inject('/');
    expect(list.body).toContain('1 unsynced');
    expect(list.body).toContain('unsynced-badge');
    expect(list.body).toMatch(/class="was"[^>]*>1</);
    expect(list.body).toMatch(/class="is"[^>]*>2</);
    expect(list.body).toContain('11 Sep 2026, 00:00 UTC');
    const page = await app.inject('/p/web?env=dev');
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/class="idle"[^]*1 unsynced change/);
    expect(page.body).toMatch(/class="idle"[^]*COUNT/);
    expect(page.body).toMatch(/class="was"[^>]*>1</);
    expect(page.body).toMatch(/class="is"[^>]*>2</);
    expect(page.body).toContain('unsynced-badge');
    const preview = await app.inject({ url: '/sync', headers: { 'hx-request': 'true' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('sync-heading peek');
    expect(preview.body).toMatch(/class="was"[^>]*>1</);
    expect(preview.body).toMatch(/class="is"[^>]*>2</);
    expect(preview.body).toContain('11 Sep 2026, 00:00 UTC');
    expect(preview.body).toContain('Changelog');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('labels schema variables as added or removed on the sync page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unsynced-schema-'));
  const db = new DBEngine(root);
  const loader = new ConfigLoader({
    decrypt: async (_path: string, source: string) => source,
  } as never);
  const operations = new ProductWriteOperations({
    db,
    loader,
    encryptor: { encrypt: async (_path: string, source: string) => source } as never,
  });
  await db.write({ path: 'environments.yaml', content: 'order: [dev]' });
  await operations.createProduct(
    {
      service: 'iam',
      uid: 1001,
      environments: ['dev'],
      schema:
        'version: 1\nkeys:\n  ADAS_WE: {type: string}\n  ADAS_WEWE: {type: string}\n  DDEE__QQ: {type: string}\n',
      defaults: {},
    },
    { email: 'test@example.com', id: 'test' },
  );
  const app = Fastify();
  await app.register(formbody);
  registerLiveUiRoutes(app, {
    db,
    loader,
    operations,
    pendingSync: async () => ({
      ready: true,
      entries: [
        {
          actor: 'test@example.com',
          path: 'schema/iam.yaml',
          keys: ['ADAS_WE', 'ADAS_WEWE', 'DDEE__QQ', 'DDEE__QQ__QQ'],
          revision: '1',
          timestamp: '2026-09-11T00:00:00.000Z',
        },
      ],
      unpushed: [],
    }),
    readSynced: async (path) =>
      path === 'schema/iam.yaml'
        ? 'version: 1\nkeys:\n  DDEE__QQ: {type: string}\n  DDEE__QQ__QQ: {type: string}\n'
        : undefined,
    syncScheduler: {
      syncNow: async () => ({ kind: 'clean' as const, files: [] }),
      isAutoSync: () => false,
      setAutoSync: () => {},
    },
  });
  try {
    const preview = await app.inject({ url: '/sync', headers: { 'hx-request': 'true' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('Iam schema');
    expect(preview.body).toMatch(/ADAS_WE<\/span>\s*<span class="sync-added">\s*\( Added \)/);
    expect(preview.body).toMatch(/ADAS_WEWE<\/span>\s*<span class="sync-added">\s*\( Added \)/);
    expect(preview.body).toMatch(/DDEE__QQ__QQ<\/span>\s*<span class="sync-archived">\s*\( Removed \)/);
    expect(preview.body).not.toMatch(/diffkey">DDEE__QQ</);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
