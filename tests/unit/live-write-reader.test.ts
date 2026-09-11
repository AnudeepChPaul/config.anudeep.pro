import { ServiceRegistry } from '@config/src/identity/registry.js';
import { registerInternalRoutes } from '@config/src/routes/internal.js';
import { ConfigCache } from '@config/src/store/cache.js';
import Fastify from 'fastify';
import { expect, it } from 'vitest';

it('accepts the empty registry produced when the last product is archived', () => {
  const registry = ServiceRegistry.fromYaml('version: 1\nservices: []\n');
  expect(registry.services()).toEqual([]);
  expect(registry.identify(1001)).toBeNull();
});
it('rechecks authorization when an archived product wakes a waiting reader', async () => {
  const cache = new ConfigCache();
  cache.reload({ commit: '1', namespaces: new Map([['web/dev', { COUNT: 1 }]]) });
  let granted = true;
  let reached!: () => void;
  const authorized = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const app = Fastify();
  registerInternalRoutes(app, {
    cache,
    onRead: () => {},
    waitTimeoutMs: 500,
    guard: {
      authorize: () => {
        reached();
        return granted
          ? { ok: true, value: { uid: 1001, name: 'web' } }
          : { ok: false, error: { status: 403, code: 'forbidden' } };
      },
    } as never,
  });
  try {
    const waiting = app.inject({ url: '/config/web/dev?since=1' });
    const response = waiting.then((value) => value);
    await authorized;
    granted = false;
    cache.reload({ commit: '2', namespaces: new Map() });
    expect((await response).statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
