import { registerUiRoutes } from '@config/src/routes/ui.js';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

const dbWith = (environments: string) =>
  ({
    snapshot: async () => ({
      revision: 1,
      files: new Map([
        ['environments.yaml', environments],
        ['schema.yaml', 'version: 1\nservices: {}'],
        ['services.yaml', 'version: 1\nservices: []'],
      ]),
    }),
  }) as never;

describe('feature flag routes', () => {
  it('adds a disabled feature from the inline form and returns the refreshed page', async () => {
    let flags: Record<string, Record<string, boolean>> = {};
    const service = {
      all: async () => flags,
      set: async (name: string, environment: string, value: boolean) => {
        flags = { ...flags, [name]: { ...(flags[name] ?? {}), [environment]: value } };
        return { kind: 'written', revision: '1', etag: 'etag' } as const;
      },
    };
    const app = Fastify({ logger: false });
    await app.register(formbody);
    registerUiRoutes(app, {
      db: dbWith('order: [dev, qa, prod]\n'),
      loader: {} as never,
      operations: {} as never,
      flagWriteService: service as never,
    });
    await app.ready();

    const page = await app.inject({ url: '/features?env=qa' });
    expect(page.body).toContain('href="/features?env=qa"');
    expect(page.body).toContain('href="/features?env=prod"');
    expect(page.body).toContain('Feature flags · qa');
    const add = await app.inject({ url: '/features/new?env=qa' });
    expect(add.body).toContain('name="environment" value="qa"');

    const response = await app.inject({
      method: 'POST',
      url: '/features',
      payload: 'name=NewCheckout&environment=qa',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('NewCheckout');
    expect(response.body).toContain('features');
    expect(flags).toEqual({ NewCheckout: { qa: false } });
    expect(response.body).toContain('Feature flags · qa');
    const invalid = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'BAD', environment: 'unknown' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('returns only an add list item for the toolbar action', async () => {
    const app = Fastify({ logger: false });
    registerUiRoutes(app, {
      db: dbWith('order: [dev, prod]\n'),
      loader: {} as never,
      operations: {} as never,
      flagWriteService: { all: async () => ({}) } as never,
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/features/new' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/^<li[^>]*>/);
    expect(response.body).toContain('name="name"');
    expect(response.body).not.toContain('<nav');
    await app.close();
  });
});
