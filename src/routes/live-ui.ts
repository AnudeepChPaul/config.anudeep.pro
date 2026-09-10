import { buildInfo, buildLabel } from '@config/src/build-info.js';
import type { FlagWriteService } from '@config/src/flags/flag-write-service.js';
import { defaultsOf, keyBodies, keyDrafts } from '@config/src/routes/product-form.js';
import { buildSchema } from '@config/src/schema/builder.js';
import type { SchemaWriteService } from '@config/src/schema/schema-write-service.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { type DBEngine, etagFor } from '@config/src/store/data-layer.js';
import { EnvironmentOrder } from '@config/src/store/environment-order.js';
import type { ConfigLoader } from '@config/src/store/loader.js';
import { versionOf } from '@config/src/store/metadata.js';
import {
  type ProductWriteOperations,
  productBase,
} from '@config/src/store/product-write-operations.js';
import type { SyncScheduler } from '@config/src/store/sync-scheduler.js';
import { renderFeatureAddRow, renderFeatures } from '@config/src/views/feature-pages.js';
import {
  type LivePageOptions,
  renderConfirmation,
  renderLiveProduct,
  renderLiveProducts,
} from '@config/src/views/live-pages.js';
import { renderNewProduct } from '@config/src/views/new-product-page.js';
import { renderSettings } from '@config/src/views/pages.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parse } from 'yaml';

export interface LiveUiOptions {
  readonly db: DBEngine;
  readonly loader: ConfigLoader;
  readonly operations: ProductWriteOperations;
  readonly flagWriteService?: FlagWriteService;
  readonly schemaWriteService?: Pick<SchemaWriteService, 'save'>;
  readonly syncScheduler?: Pick<SyncScheduler, 'syncNow'>;
  readonly pendingBackup?: () => Promise<number>;
  readonly settings?: { enabled: boolean; allow: readonly string[] };
  readonly onCommitted?: () => void | Promise<void>;
}
type Body = Record<string, string | string[]>;
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];
const text = (value: unknown): string => list(value).at(-1) ?? '';
const isHtmx = (request: FastifyRequest) => request.headers['hx-request'] === 'true';
const actor = (request: FastifyRequest) => ({
  email: request.session?.email ?? 'unauthenticated@localhost',
  id: request.session?.id ?? 'anonymous',
  // A change made under break-glass was made while the identity provider was down and nobody
  // could be checked against it. That belongs in the record, not only in the alert that fired
  // at the time -- so it travels with the write and reaches the commit the sync engine writes.
  via: request.session?.via,
});
const send = (reply: FastifyReply, page: unknown, status = 200) =>
  reply.code(status).type('text/html; charset=utf-8').send(String(page));
const backTo = (service: string, environment: string) =>
  `/p/${service}?env=${encodeURIComponent(environment)}`;

export function registerLiveUiRoutes(app: FastifyInstance, options: LiveUiOptions): void {
  const { db, loader, operations } = options;
  const maySeeSettings = (request: FastifyRequest) =>
    !!options.settings?.enabled &&
    !!request.session &&
    (request.session.via === 'break-glass' ||
      options.settings.allow.includes(request.session.email.trim().toLowerCase()));
  const common = (request: FastifyRequest): LivePageOptions => ({
    fragment: isHtmx(request),
    settingsLink: maySeeSettings(request),
    build: buildLabel(buildInfo()),
  });
  const state = async () => {
    const snapshot = await db.snapshot();
    const schemas = SchemaSet.fromDocument(
      snapshot.files.get('schema.yaml') ?? 'version: 1\nservices: {}',
    );
    const registry = parse(snapshot.files.get('services.yaml') ?? 'version: 1\nservices: []') as {
      services: { name: string; uid: number }[];
    };
    const order = EnvironmentOrder.fromYaml(snapshot.files.get('environments.yaml') ?? '');
    return { ...snapshot, schemas, registry, order };
  };
  const productPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    service: string,
    environment?: string,
    submitted: Body = {},
    notice?: LivePageOptions['notice'],
    status = 200,
  ) => {
    const current = await state();
    if (
      !current.registry.services.some((entry) => entry.name === service) ||
      !current.schemas.has(service)
    )
      return reply.code(404).send('Not found');
    const active = environment || current.order.all()[0] || '';
    if (!current.order.all().includes(active)) return reply.code(400).send('Unknown environment');
    const path = `config/${service}/${active}.yaml`;
    const source = current.files.get(path);
    const values =
      source === undefined ? {} : await loader.resolveOne(`${service}/${active}`, source);
    const rows = [...current.schemas.definitionsFor(service)].map(([key, definition]) => {
      const typed = submitted[`key.${key}`];
      const value = definition.secret
        ? undefined
        : typed === undefined
          ? values[key]
          : definition.type === 'bool'
            ? text(typed) === 'true'
            : definition.type === 'string[]'
              ? text(typed)
                  .split(',')
                  .map((value) => value.trim())
              : text(typed);
      return { key, definition, value };
    });
    // Without this an htmx navigation between environments leaves the address bar on the old
    // one, so a reload lands on a different screen from the one being read.
    if (isHtmx(request))
      reply.header('hx-push-url', `/p/${service}?env=${encodeURIComponent(active)}`);
    return send(
      reply,
      renderLiveProduct({
        ...common(request),
        notice,
        service,
        environment: active,
        environments: current.order.all(),
        rows,
        version: versionOf(values),
        etag: source === undefined ? null : etagFor(source),
        next: current.order.next(active),
        retiring: current.schemas.isRetiring(service),
        missing: source === undefined,
      }),
      status,
    );
  };
  const resultPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    service: string,
    environment: string,
    result: Awaited<ReturnType<ProductWriteOperations['writeValues']>>,
    submitted: Body = {},
  ) => {
    if (result.ok) {
      await options.onCommitted?.();
      if (!isHtmx(request))
        return reply
          .code(303)
          .header('location', `${backTo(service, environment)}&done=saved`)
          .send();
      return productPage(
        request,
        reply,
        service,
        environment,
        {},
        { tone: 'done', text: `Live now in ${service}/${environment}` },
      );
    }
    return productPage(
      request,
      reply,
      service,
      environment,
      submitted,
      { tone: 'problem', text: result.error.detail },
      result.error.code === 'conflict' ? 409 : 422,
    );
  };
  for (const url of ['/', '/p/retiring'])
    app.get(url, async (request, reply) => {
      const current = await state();
      return send(
        reply,
        renderLiveProducts({
          ...common(request),
          products: current.registry.services.map((entry) => ({
            name: entry.name,
            uid: entry.uid,
            retiring: current.schemas.isRetiring(entry.name),
            environments: current.order.all(),
            keys: [...current.schemas.definitionsFor(entry.name).keys()],
          })),
          pendingBackup: (await options.pendingBackup?.()) ?? 0,
          retiringOnly: url !== '/',
          query: text((request.query as Body).q),
        }),
      );
    });
  app.get(
    '/p/:service',
    async (request: FastifyRequest<{ Params: { service: string }; Querystring: Body }>, reply) => {
      const environment = text(request.query.env);
      return productPage(
        request,
        reply,
        request.params.service,
        environment,
        {},
        request.query.done === 'saved'
          ? { tone: 'done', text: `Live now in ${request.params.service}/${environment}` }
          : undefined,
      );
    },
  );
  app.post(
    '/p/:service/:environment',
    async (
      request: FastifyRequest<{ Params: { service: string; environment: string }; Body: Body }>,
      reply,
    ) => {
      const { service, environment } = request.params;
      const body = request.body ?? {};
      const current = await state();
      if (body.intent === 'create' && body.confirm !== 'yes')
        return send(
          reply,
          renderConfirmation({
            ...common(request),
            title: `Create ${service}/${environment}?`,
            message:
              'The schema defaults will be live immediately. Existing files will not be overwritten.',
            action: `/p/${service}/${environment}`,
            fields: { intent: 'create', base: productBase(current.files, service) },
            back: backTo(service, environment),
          }),
        );
      if (body.intent === 'create' && text(body.base) !== productBase(current.files, service))
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          { tone: 'problem', text: 'Product changed; review the defaults again.' },
          409,
        );
      const changes: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(body))
        if (name.startsWith('key.')) {
          const key = name.slice(4);
          const definition = current.schemas.definitionsFor(service).get(key);
          const raw = text(value);
          if (definition?.secret && raw === '') continue;
          changes[key] =
            definition?.type === 'int'
              ? raw.trim() === ''
                ? raw
                : Number(raw)
              : definition?.type === 'bool'
                ? raw === 'true'
                : definition?.type === 'string[]'
                  ? raw
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean)
                  : raw;
        }
      if (body.intent !== 'create' && typeof body.etag !== 'string')
        return productPage(
          request,
          reply,
          service,
          environment,
          body,
          { tone: 'problem', text: 'Reload this page before saving; its file version is missing.' },
          409,
        );
      const result = await operations.writeValues(
        {
          service,
          environment,
          changes: body.intent === 'create' ? current.schemas.defaultsFor(service) : changes,
          expectedEtag: body.intent === 'create' ? null : text(body.etag),
        },
        actor(request),
      );
      return resultPage(request, reply, service, environment, result, body);
    },
  );
  app.post('/promote', async (request: FastifyRequest<{ Body: Body }>, reply) => {
    const body = request.body ?? {};
    const service = text(body.service);
    const from = text(body.from);
    const to = text(body.to);
    const result = await operations.promote(
      { service, from, to, keys: list(body.select) },
      actor(request),
    );
    return resultPage(request, reply, service, result.ok ? to : from, result);
  });
  app.post(
    '/p/:service/delete-keys',
    async (request: FastifyRequest<{ Params: { service: string }; Body: Body }>, reply) => {
      const service = request.params.service;
      const body = request.body ?? {};
      const environment = text(body.environment);
      const keys = list(body.select);
      const current = await state();
      if (!keys.length || keys.some((key) => !current.schemas.definitionsFor(service).has(key)))
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          { tone: 'problem', text: 'Select declared keys to remove.' },
          422,
        );
      const environments = [...current.files.keys()]
        .filter((path) => path.startsWith(`config/${service}/`) && path.endsWith('.yaml'))
        .map((path) => path.slice(`config/${service}/`.length, -5));
      if (body.confirm !== 'yes')
        return send(
          reply,
          renderConfirmation({
            ...common(request),
            title: `Remove ${keys.length} keys from ${service}?`,
            message: `${keys.join(', ')} will be removed from the schema and from ${environments.join(', ')}. Services fall back to their own compiled-in defaults. There is no undo; restoring these keys requires declaring them and retyping their values.`,
            action: `/p/${service}/delete-keys`,
            fields: { select: keys, environment, base: productBase(current.files, service) },
            back: backTo(service, environment),
          }),
        );
      const result = await operations.deleteKeys(service, keys, actor(request), text(body.base));
      return resultPage(request, reply, service, environment, result);
    },
  );
  app.post(
    '/p/:service/retire',
    async (request: FastifyRequest<{ Params: { service: string }; Body: Body }>, reply) => {
      const service = request.params.service;
      const body = request.body ?? {};
      const retiring = body.retiring !== 'false';
      if (retiring && body.confirm !== 'yes')
        return send(
          reply,
          renderConfirmation({
            ...common(request),
            title: `Retire ${service}?`,
            message:
              'Consumers will see the retirement mark immediately. Configuration and access remain available until archive.',
            action: `/p/${service}/retire`,
            fields: { retiring: 'true' },
            back: `/p/${service}`,
          }),
        );
      const result = await operations.setRetiring(service, retiring, actor(request));
      if (!result.ok)
        return reply.code(result.error.code === 'conflict' ? 409 : 422).send(result.error);
      await options.onCommitted?.();
      return reply.code(303).header('location', `/p/${service}`).send();
    },
  );
  app.post(
    '/p/:service/archive',
    async (request: FastifyRequest<{ Params: { service: string }; Body: Body }>, reply) => {
      const service = request.params.service;
      const current = await state();
      const body = request.body ?? {};
      if (body.confirm !== 'yes')
        return send(
          reply,
          renderConfirmation({
            ...common(request),
            title: `Archive ${service}?`,
            message:
              'This removes all live configuration and grants. Encrypted environment files are preserved in the archive.',
            action: `/p/${service}/archive`,
            fields: { base: productBase(current.files, service) },
            back: '/p/retiring',
          }),
        );
      const result = await operations.archiveProduct(service, actor(request), text(body.base));
      if (!result.ok)
        return reply.code(result.error.code === 'conflict' ? 409 : 422).send(result.error);
      await options.onCommitted?.();
      return reply.code(303).header('location', '/p/retiring').send();
    },
  );
  app.get('/p/new', async (request, reply) =>
    send(
      reply,
      renderNewProduct({ ...common(request), environments: (await state()).order.all() }),
    ),
  );
  app.post('/p/new', async (request: FastifyRequest<{ Body: Body }>, reply) => {
    const body = request.body ?? {};
    const service = text(body.name).trim();
    const keys = keyDrafts(body);
    const schema = buildSchema({ service, keys });
    const current = await state();
    const result = schema.ok
      ? await operations.createProduct(
          {
            service,
            uid: /^\d+$/.test(text(body.uid)) ? Number(text(body.uid)) : Number.NaN,
            environments: list(body.environment),
            schema: schema.value,
            defaults: defaultsOf(keys),
          },
          actor(request),
        )
      : {
          ok: false as const,
          error: { code: 'invalid', detail: 'Invalid schema', errors: schema.error },
        };
    if (!result.ok)
      return send(
        reply,
        renderNewProduct({
          ...common(request),
          environments: current.order.all(),
          typed: {
            name: service,
            uid: text(body.uid),
            environments: list(body.environment),
            keys: keyBodies(body),
          },
          problems: result.error.errors ?? [{ key: '', message: result.error.detail }],
        }),
        result.error.code === 'conflict' ? 409 : 422,
      );
    await options.onCommitted?.();
    return reply.code(303).header('location', `/p/${service}`).send();
  });
  app.get('/settings', async (request, reply) =>
    maySeeSettings(request)
      ? send(reply, renderSettings({ env: process.env, ...common(request) }))
      : reply.code(404).send('Not found'),
  );
  const declaredEnvironments = async () => (await state()).order.all();
  registerFeatureRoutes(app, options, declaredEnvironments);
}
function registerFeatureRoutes(
  app: FastifyInstance,
  options: LiveUiOptions,
  declaredEnvironments: () => Promise<readonly string[]>,
): void {
  app.get('/features', async (request, reply) => {
    if (!options.flagWriteService) return reply.code(404).send('Not found');
    const flags = await options.flagWriteService.all();
    const query = request.query as { env?: string };
    const environments = await declaredEnvironments();
    const environment = query.env?.trim() || environments[0] || '';
    if (environment && !environments.includes(environment))
      return reply.code(400).send('Unknown environment');
    return reply
      .type('text/html; charset=utf-8')
      .send(
        String(renderFeatures({ flags, environment, environments, fragment: isHtmx(request) })),
      );
  });

  app.get('/features/new', async (request, reply) => {
    if (!options.flagWriteService) return reply.code(404).send('Not found');
    const environments = await declaredEnvironments();
    const environment = (request.query as { env?: string }).env || environments[0] || '';
    if (!environments.includes(environment)) return reply.code(400).send('Unknown environment');
    return reply.type('text/html; charset=utf-8').send(String(renderFeatureAddRow(environment)));
  });

  app.post('/sync', async (_request, reply) => {
    if (!options.syncScheduler) return reply.code(404).send('Not found');
    return reply.send(await options.syncScheduler.syncNow());
  });

  app.post(
    '/schema',
    async (request: FastifyRequest<{ Body: { source?: string; etag?: string } }>, reply) => {
      if (!options.schemaWriteService) return reply.code(404).send('Not found');
      const body = request.body ?? {};
      const result = await options.schemaWriteService.save(String(body.source ?? ''), body.etag);
      if (result.kind === 'invalid') return reply.code(422).send(result);
      if (result.kind === 'conflict') return reply.code(409).send(result);
      await options.onCommitted?.();
      return reply.send(result);
    },
  );

  app.post(
    '/features',
    async (request: FastifyRequest<{ Body: { name?: string; environment?: string } }>, reply) => {
      if (!options.flagWriteService) return reply.code(404).send('Not found');
      const body = request.body ?? {};
      const name = String(body.name ?? '').trim();
      const environments = await declaredEnvironments();
      const environment = String(body.environment ?? environments[0] ?? '').trim();
      if (!environments.includes(environment)) return reply.code(400).send('Unknown environment');
      const result = await options.flagWriteService.set(
        name,
        environment,
        false,
        undefined,
        request.session?.email,
      );
      if (result.kind === 'conflict') return reply.code(409).send(result);
      if (result.kind === 'invalid') return reply.code(422).send(result);
      await options.onCommitted?.();
      const flags = await options.flagWriteService.all();
      return reply
        .type('text/html; charset=utf-8')
        .send(
          String(renderFeatures({ flags, environment, environments, fragment: isHtmx(request) })),
        );
    },
  );

  app.post(
    '/features/:name',
    async (
      request: FastifyRequest<{
        Params: { name: string };
        Body: { value?: string; environment?: string };
      }>,
      reply,
    ) => {
      if (!options.flagWriteService) return reply.code(404).send('Not found');
      const body = request.body ?? {};
      const environments = await declaredEnvironments();
      const environment = String(body.environment ?? environments[0] ?? '').trim();
      if (!environments.includes(environment)) return reply.code(400).send('Unknown environment');
      const result = await options.flagWriteService.set(
        request.params.name,
        environment,
        String(body.value ?? '') === 'true' || String(body.value ?? '') === 'on',
        undefined,
        request.session?.email,
      );
      if (result.kind === 'conflict') return reply.code(409).send(result);
      if (result.kind === 'invalid') return reply.code(422).send(result);
      await options.onCommitted?.();
      const flags = await options.flagWriteService.all();
      return reply
        .type('text/html; charset=utf-8')
        .send(
          String(renderFeatures({ flags, environment, environments, fragment: isHtmx(request) })),
        );
    },
  );

  app.post(
    '/flags',
    async (
      request: FastifyRequest<{
        Body: {
          name?: string;
          environment?: string;
          value?: string;
          etag?: string;
          confirm?: string;
        };
      }>,
      reply,
    ) => {
      if (!options.flagWriteService) return reply.code(404).send('Not found');
      const body = request.body ?? {};
      if (String(body.environment ?? '') === 'prod' && String(body.confirm ?? '') !== 'prod') {
        return reply.code(400).send({ code: 'confirmation_required', environment: 'prod' });
      }
      const result = await options.flagWriteService.set(
        String(body.name ?? ''),
        String(body.environment ?? ''),
        String(body.value ?? '') === 'true',
        body.etag,
        request.session?.email,
      );
      if (result.kind === 'conflict') return reply.code(409).send(result);
      if (result.kind === 'invalid') return reply.code(422).send(result);
      await options.onCommitted?.();
      return reply.send(result);
    },
  );
}
