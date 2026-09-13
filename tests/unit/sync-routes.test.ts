import { registerUiRoutes } from '@config/src/routes/ui.js';
import { SyncStatus } from '@config/src/store/sync-status.js';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const db = {
  snapshot: async () => ({
    revision: 1,
    files: new Map([
      ['environments.yaml', 'order: [dev]\n'],
      ['services.yaml', 'version: 1\nservices: []'],
    ]),
  }),
} as never;

const appWith = async (
  over: Parameters<typeof registerUiRoutes>[1] extends infer T ? Partial<T> : never,
) => {
  const app = Fastify({ logger: false });
  await app.register(formbody);
  registerUiRoutes(app, {
    db,
    loader: {} as never,
    operations: {} as never,
    ...over,
  });
  await app.ready();
  return app;
};

describe('sync routes', () => {
  it('lists pending actions and does not sync on GET', async () => {
    const syncNow = vi.fn(async () => ({ kind: 'clean' as const, files: [] }));
    const app = await appWith({
      syncScheduler: { syncNow, isAutoSync: () => false, setAutoSync: () => {} },
      pendingSync: async () => ({
        ready: true,
        entries: [
          {
            actor: 'op@example.com',
            path: 'config/iam/prod.yaml',
            keys: ['SESSION_TTL'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
        ],
        unpushed: [{ sha: 'abc' as never, subject: 'sync iam' }],
      }),
    });
    const page = await app.inject({ url: '/sync' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('SESSION_TTL');
    expect(page.body).toContain('sync iam');
    expect(page.body).toContain('2 actions to sync');
    expect(page.body).toContain('Confirm');
    expect(page.body).toContain('Cancel');
    expect(syncNow).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a fragment card for htmx', async () => {
    const app = await appWith({
      syncScheduler: {
        syncNow: async () => ({ kind: 'clean' as const, files: [] }),
        isAutoSync: () => false,
        setAutoSync: () => {},
      },
      pendingSync: async () => ({
        ready: true,
        entries: [
          {
            actor: 'op@example.com',
            path: 'config/iam/prod.yaml',
            keys: ['A'],
            revision: '1',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
        ],
        unpushed: [],
      }),
    });
    const page = await app.inject({ url: '/sync', headers: { 'hx-request': 'true' } });
    expect(page.body).toContain('id="sync-card"');
    expect(page.body).not.toContain('<!doctype html>');
    await app.close();
  });

  it('redirects GET /sync when nothing is pending', async () => {
    const app = await appWith({
      syncScheduler: {
        syncNow: async () => ({ kind: 'clean' as const, files: [] }),
        isAutoSync: () => false,
        setAutoSync: () => {},
      },
      pendingSync: async () => ({ ready: false, entries: [], unpushed: [] }),
    });
    const page = await app.inject({ url: '/sync' });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe('/');
    await app.close();
  });

  it('runs syncNow once on confirm and redirects instead of returning JSON', async () => {
    const syncNow = vi.fn(async () => ({ kind: 'synced' as const, files: ['a'], commit: '1' }));
    const app = await appWith({
      syncScheduler: { syncNow, isAutoSync: () => false, setAutoSync: () => {} },
    });
    const missing = await app.inject({ method: 'POST', url: '/sync', payload: {} });
    expect(missing.statusCode).toBe(303);
    expect(missing.headers.location).toBe('/sync');
    expect(syncNow).not.toHaveBeenCalled();

    const confirmed = await app.inject({
      method: 'POST',
      url: '/sync',
      payload: { confirm: 'yes' },
    });
    expect(confirmed.statusCode).toBe(303);
    expect(String(confirmed.headers.location)).toContain('done=backed-up');
    expect(String(confirmed.headers['content-type'] ?? '')).not.toMatch(/json/);
    expect(syncNow).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('enabling auto-sync persists and flushes immediately', async () => {
    const syncNow = vi.fn(async () => ({ kind: 'synced' as const, files: ['a'], commit: '1' }));
    const write = vi.fn(async () => {});
    const setAutoSync = vi.fn();
    const app = await appWith({
      syncScheduler: { syncNow, isAutoSync: () => false, setAutoSync },
      autoSyncStore: { read: async () => false, write },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/sync/auto',
      payload: { autoSync: 'true', next: '/p/iam' },
    });
    expect(write).toHaveBeenCalledWith(true);
    expect(setAutoSync).toHaveBeenCalledWith(true);
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(String(response.headers.location)).toContain('/p/iam');
    expect(String(response.headers.location)).toContain('done=backed-up');
    await app.close();
  });

  it('returns to the htmx page when auto-sync is turned off', async () => {
    const write = vi.fn(async () => {});
    const app = await appWith({
      syncScheduler: {
        syncNow: async () => ({ kind: 'clean' as const, files: [] }),
        isAutoSync: () => true,
        setAutoSync: () => {},
      },
      autoSyncStore: { read: async () => true, write },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/sync/auto',
      payload: { autoSync: 'false' },
      headers: { 'hx-current-url': 'http://127.0.0.1:8200/features?env=dev' },
    });
    expect(write).toHaveBeenCalledWith(false);
    expect(response.headers.location).toBe('/features?env=dev');
    await app.close();
  });

  it('surfaces a thrown sync as backup-failed', async () => {
    const status = new SyncStatus();
    const app = await appWith({
      syncScheduler: {
        syncNow: async () => {
          throw new Error('boom');
        },
        isAutoSync: () => false,
        setAutoSync: () => {},
      },
      syncStatus: status,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/sync',
      payload: { confirm: 'yes' },
    });
    expect(response.headers.location).toBe('/?done=backup-failed');
    expect(status.notice()?.tone).toBe('problem');
    await app.close();
  });
});
