import { isDeepStrictEqual } from 'node:util';
import { buildInfo, buildLabel } from '@config/src/build-info.js';
import type { FlagWriteService } from '@config/src/flags/flag-write-service.js';
import { logCaught, logRefused } from '@config/src/logging.js';
import { allKeyBodies, defaultsOf, keyBodies, keyDrafts } from '@config/src/routes/product-form.js';
import { nextPathFromRequest, safeNextPath } from '@config/src/routes/safe-next-path.js';
import { buildSchema } from '@config/src/schema/builder.js';
import type { SchemaWriteService } from '@config/src/schema/schema-write-service.js';
import { SchemaSet } from '@config/src/schema/validator.js';
import { type DBEngine, etagFor } from '@config/src/store/data-layer.js';
import { EnvironmentOrder } from '@config/src/store/environment-order.js';
import type { ConfigLoader } from '@config/src/store/loader.js';
import { isMetadataKey, versionOf } from '@config/src/store/metadata.js';
import type { PendingSyncReport } from '@config/src/store/pending-sync.js';
import {
  ARCHIVE_ALREADY_EXISTS,
  type ProductWriteOperations,
  productBase,
} from '@config/src/store/product-write-operations.js';
import type { SyncResult } from '@config/src/store/sync-engine.js';
import type { SyncScheduler } from '@config/src/store/sync-scheduler.js';
import type { SyncStatus } from '@config/src/store/sync-status.js';
import { unsyncedKeyCounts, unsyncedTotal } from '@config/src/store/unsynced.js';
import { shouldSwapHeader } from '@config/src/views/console-tab.js';
import { renderFeatureAddRow, renderFeatures } from '@config/src/views/feature-pages.js';
import { presentWriteFailure } from '@config/src/views/field-errors.js';
import {
  type LivePageOptions,
  type UnsyncedChange,
  renderConfirmation,
  renderLiveProduct,
  renderLiveProducts,
  renderSyncPreview,
} from '@config/src/views/live-pages.js';
import { renderNewProduct } from '@config/src/views/new-product-page.js';
import { noticeFor } from '@config/src/views/notices.js';
import type { PageNotice } from '@config/src/views/page-frame.js';
import { renderSettings } from '@config/src/views/pages.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parse } from 'yaml';

export interface LiveUiOptions {
  readonly db: DBEngine;
  readonly loader: ConfigLoader;
  readonly operations: ProductWriteOperations;
  readonly flagWriteService?: FlagWriteService;
  readonly schemaWriteService?: Pick<SchemaWriteService, 'save'>;
  readonly syncScheduler?: Pick<SyncScheduler, 'syncNow' | 'isAutoSync' | 'setAutoSync'>;
  readonly pendingSync?: () => Promise<PendingSyncReport>;
  /** Last Git copy of a path, or null when the clone has never committed it. */
  readonly readSynced?: (path: string) => Promise<string | null>;
  readonly autoSyncStore?: { read(): Promise<boolean>; write(enabled: boolean): Promise<void> };
  readonly syncStatus?: Pick<SyncStatus, 'notice' | 'clear' | 'noteError' | 'noteResult'>;
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
const problemFields = (errors: readonly { key: string; message: string }[] | undefined) => ({
  error_keys: errors?.map((entry) => entry.key).join(',') ?? '',
  error_messages: errors?.map((entry) => entry.message).join('; ') ?? '',
});
const refused = (event: string, fields: Record<string, string | number | boolean | undefined>) =>
  logRefused(event, { logger: 'routes.live-ui', ...fields });

export function registerLiveUiRoutes(app: FastifyInstance, options: LiveUiOptions): void {
  const { db, loader, operations } = options;
  const maySeeSettings = (request: FastifyRequest) =>
    !!options.settings?.enabled &&
    !!request.session &&
    (request.session.via === 'break-glass' ||
      options.settings.allow.includes(request.session.email.trim().toLowerCase()));
  const currentPathOf = (request: FastifyRequest) => {
    const url = request.url || '/';
    const path = url.split('?')[0] ?? '/';
    return path.startsWith('/sync') ? '/' : url;
  };
  const nextOf = (request: FastifyRequest) =>
    nextPathFromRequest({
      bodyNext: text((request.body as Body | undefined)?.next),
      hxCurrentUrl:
        typeof request.headers['hx-current-url'] === 'string'
          ? request.headers['hx-current-url']
          : undefined,
      fallback: currentPathOf(request),
    });
  const common = (
    request: FastifyRequest,
    extra: Partial<LivePageOptions> = {},
  ): LivePageOptions => {
    const query = request.query as Body;
    const fromQuery = noticeFor(text(query.done), { n: Number(text(query.n)) });
    const sticky = options.syncStatus?.notice() ?? undefined;
    const notice = extra.notice ?? fromQuery ?? sticky;
    const path = request.url.split('?')[0] ?? '/';
    const hxCurrentUrl =
      typeof request.headers['hx-current-url'] === 'string'
        ? request.headers['hx-current-url']
        : undefined;
    return {
      fragment: isHtmx(request),
      settingsLink: maySeeSettings(request),
      build: buildLabel(buildInfo()),
      autoSync: options.syncScheduler ? options.syncScheduler.isAutoSync() : undefined,
      ...extra,
      updateFooter: extra.updateFooter ?? (isHtmx(request) && path === '/sync/auto'),
      updateHeader: extra.updateHeader ?? (isHtmx(request) && shouldSwapHeader(hxCurrentUrl, path)),
      ...(notice
        ? { notice, dismissTo: extra.dismissTo ?? (fromQuery ? '/' : sticky ? '/sync/ack' : '/') }
        : {}),
    };
  };
  const afterSync = (request: FastifyRequest, reply: FastifyReply, result: SyncResult) => {
    options.syncStatus?.noteResult(result);
    const next = nextOf(request);
    if (result.kind === 'synced') {
      const params = new URLSearchParams({ done: 'backed-up' });
      if (result.files.length > 0) params.set('n', String(result.files.length));
      return reply
        .code(303)
        .header('location', `${next.split('?')[0]}?${params}`)
        .send();
    }
    if (result.kind === 'clean') return reply.code(303).header('location', next).send();
    const done = result.reason?.includes('no remote') ? 'backup-no-remote' : 'backup-deferred';
    return reply
      .code(303)
      .header('location', `${next.split('?')[0]}?done=${done}`)
      .send();
  };
  const state = async () => {
    const snapshot = await db.snapshot();
    const schemas = SchemaSet.fromTree(snapshot.files);
    const registry = parse(snapshot.files.get('services.yaml') ?? 'version: 1\nservices: []') as {
      services: { name: string; uid: number }[];
    };
    const order = EnvironmentOrder.fromYaml(snapshot.files.get('environments.yaml') ?? '');
    return { ...snapshot, schemas, registry, order };
  };
  const previousConfig = async (path: string, namespace: string) => {
    const source = await options.readSynced?.(path);
    if (!source) return {};
    try {
      return await loader.resolveOne(namespace, source);
    } catch (error) {
      logCaught(error, 'config.ui.synced.read.failed', { logger: 'routes.live-ui' });
      return {};
    }
  };
  const schemaKeys = (source: string | undefined, service: string) => {
    if (!source) return new Set<string>();
    try {
      return new Set(SchemaSet.fromFiles({ [service]: source }).definitionsFor(service).keys());
    } catch (error) {
      logCaught(error, 'config.ui.sync.schema.failed', { logger: 'routes.live-ui' });
      return new Set<string>();
    }
  };
  const pendingKeysFor = async (path: string) => [
    ...new Set(
      ((await options.pendingSync?.())?.entries ?? [])
        .filter((entry) => entry.path === path)
        .flatMap((entry) => entry.keys)
        .filter((key) => !isMetadataKey(key) && key !== 'retiring'),
    ),
  ];
  const unsyncedChanges = async (
    path: string,
    namespace: string,
    current: Record<string, unknown>,
    schemas: SchemaSet,
    service: string,
  ) => {
    const keys = await pendingKeysFor(path);
    if (keys.length === 0) return [];
    const previous = await previousConfig(path, namespace);
    return keys
      .map((key) => ({
        key,
        from: previous[key],
        to: current[key],
        secret: schemas.isSecret(service, key),
      }))
      .filter((change) => !isDeepStrictEqual(change.from, change.to));
  };
  const changelogByPath = async (
    entries: readonly { path: string }[],
    current: Awaited<ReturnType<typeof state>>,
  ) => {
    const changesByPath: Record<string, UnsyncedChange[]> = {};
    for (const path of new Set(entries.map((entry) => entry.path))) {
      const config = path.match(/^config\/([^/]+)\/([^/]+)\.yaml$/);
      if (config?.[1] && config[2]) {
        const service = config[1];
        const environment = config[2];
        const source = current.files.get(path);
        let values: Record<string, unknown> = {};
        if (source !== undefined) {
          try {
            values = await loader.resolveOne(`${service}/${environment}`, source);
          } catch (error) {
            logCaught(error, 'config.ui.sync.changelog.failed', { logger: 'routes.live-ui' });
            continue;
          }
        }
        changesByPath[path] = await unsyncedChanges(
          path,
          `${service}/${environment}`,
          values,
          current.schemas,
          service,
        );
        continue;
      }
      const schema = path.match(/^schema\/([^/]+)\.yaml$/)?.[1];
      if (!schema) continue;
      const previous = schemaKeys(await options.readSynced?.(path), schema);
      const live = new Set(current.schemas.definitionsFor(schema).keys());
      const changes: UnsyncedChange[] = [];
      for (const key of (await pendingKeysFor(path)).sort((left, right) =>
        left.localeCompare(right),
      )) {
        const now = live.has(key);
        const was = previous.has(key);
        if (now && !was) changes.push({ key, from: undefined, to: true, kind: 'added' });
        else if (was && !now) changes.push({ key, from: true, to: undefined, kind: 'removed' });
      }
      changesByPath[path] = changes;
    }
    return changesByPath;
  };
  const productPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    service: string,
    environment?: string,
    submitted: Body = {},
    notice?: LivePageOptions['notice'],
    status = 200,
    fieldErrors: Readonly<Record<string, string>> = {},
    extras: {
      retireAsk?: 'confirm' | 'force';
      keyDrafts?: ReadonlyArray<Record<string, string>>;
      keyProblems?: ReadonlyArray<{ key: string; message: string }>;
    } = {},
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
    const pending = (await options.pendingSync?.()) ?? { entries: [] };
    const changesByPath = await changelogByPath(pending.entries, current);
    const unsynced = changesByPath[path] ?? [];
    const changeByKey = Object.fromEntries(unsynced.map((change) => [change.key, change]));
    const query = text((request.query as Body).q ?? '').toLowerCase();
    const highlight = text((request.query as Body).hl ?? '');
    // What the same key holds in the other declared environments, read once for the page rather
    // than per row: promotion is a decision about the difference between two of them.
    const others = new Map<string, Record<string, unknown>>();
    for (const other of current.order.all()) {
      if (other === active) continue;
      const otherSource = current.files.get(`config/${service}/${other}.yaml`);
      if (otherSource !== undefined)
        others.set(other, await loader.resolveOne(`${service}/${other}`, otherSource));
    }
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
      const elsewhere = Object.fromEntries(
        [...others].map(([environment, held]) => [environment, held[key]]),
      );
      return {
        key,
        definition,
        value,
        elsewhere,
        found: key === highlight,
        ...(changeByKey[key] ? { change: changeByKey[key] } : {}),
        ...(fieldErrors[key] ? { error: fieldErrors[key] } : {}),
      };
    });
    // Filtering the fields, not navigating: this is still the product page, with fewer rows on
    // it, because looking for one key in a product with forty of them was a scroll.
    const shown = query ? rows.filter((row) => row.key.toLowerCase().includes(query)) : rows;
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
        rows: shown,
        query,
        version: versionOf(values),
        etag: source === undefined ? null : etagFor(source),
        next: current.order.next(active),
        retiring: current.schemas.isRetiring(service),
        missing: source === undefined,
        entries: pending.entries,
        changesByPath,
        retireAsk: extras.retireAsk,
        keyDrafts: extras.keyDrafts,
        keyProblems: extras.keyProblems,
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
    done: 'saved' | 'promoted' | 'deleted' | 'created' | 'keys-added' = 'saved',
  ) => {
    if (result.ok) {
      await options.onCommitted?.();
      const count = result.value.changedKeys.length;
      const notice =
        done === 'promoted'
          ? {
              tone: 'done' as const,
              text:
                count === 0
                  ? 'Promoted. Live now.'
                  : `Promoted ${count} key${count === 1 ? '' : 's'}. Live now.`,
            }
          : done === 'deleted'
            ? {
                tone: 'done' as const,
                text:
                  count === 0
                    ? 'Keys removed from the schema and every environment.'
                    : `Removed ${count} key${count === 1 ? '' : 's'} from the schema and every environment.`,
              }
            : done === 'created'
              ? { tone: 'done' as const, text: 'Created from schema defaults. Live now.' }
              : done === 'keys-added'
                ? {
                    tone: 'done' as const,
                    text:
                      count === 0
                        ? 'Variables added. Live now.'
                        : `Added ${count} variable${count === 1 ? '' : 's'}. Live now.`,
                  }
                : { tone: 'done' as const, text: `Live now in ${service}/${environment}` };
      if (!isHtmx(request)) {
        const params = new URLSearchParams({ env: environment, done });
        if (count > 0 && (done === 'promoted' || done === 'deleted' || done === 'keys-added'))
          params.set('n', String(count));
        return reply.code(303).header('location', `/p/${service}?${params}`).send();
      }
      return productPage(request, reply, service, environment, {}, notice);
    }
    const presented = presentWriteFailure(result.error);
    refused('config.ui.write.failed', {
      service,
      environment,
      code: result.error.code,
      detail: result.error.detail,
      status: result.error.code === 'conflict' ? 409 : 422,
      ...problemFields(result.error.errors),
    });
    return productPage(
      request,
      reply,
      service,
      environment,
      submitted,
      presented.notice,
      result.error.code === 'conflict' ? 409 : 422,
      presented.byKey,
    );
  };
  const listProducts = async (
    request: FastifyRequest,
    reply: FastifyReply,
    retiringOnly: boolean,
    extra: {
      archiveAsk?: { service: string; kind: 'confirm' | 'force'; base?: string };
      notice?: PageNotice;
      status?: number;
    } = {},
  ) => {
    const current = await state();
    const pending = (await options.pendingSync?.()) ?? {
      entries: [],
      unpushed: [],
      ready: false,
    };
    const counts = unsyncedKeyCounts(pending.entries);
    const changesByPath = await changelogByPath(pending.entries, current);
    return send(
      reply,
      renderLiveProducts({
        ...common(request),
        notice: extra.notice,
        archiveAsk: extra.archiveAsk,
        products: current.registry.services.map((entry) => {
          const missingSchema = !current.schemas.has(entry.name);
          return {
            name: entry.name,
            uid: entry.uid,
            retiring: current.schemas.isRetiring(entry.name),
            environments: current.order.all(),
            keys: missingSchema ? [] : [...current.schemas.definitionsFor(entry.name).keys()],
            missingSchema,
            unsynced: counts.get(entry.name) ?? 0,
          };
        }),
        unsynced: unsyncedTotal(counts),
        showSyncNow: Boolean(
          options.syncScheduler && !options.syncScheduler.isAutoSync() && pending.ready,
        ),
        entries: pending.entries,
        changesByPath,
        retiringOnly,
        query: text((request.query as Body).q),
      }),
      extra.status ?? 200,
    );
  };
  for (const url of ['/', '/p/retiring'])
    app.get(url, async (request, reply) => listProducts(request, reply, url !== '/'));
  app.get(
    '/p/:service',
    async (request: FastifyRequest<{ Params: { service: string }; Querystring: Body }>, reply) => {
      const environment = text(request.query.env);
      const done = text(request.query.done);
      const count = Number(text(request.query.n));
      const notice =
        done === 'saved'
          ? { tone: 'done' as const, text: `Live now in ${request.params.service}/${environment}` }
          : done === 'created'
            ? { tone: 'done' as const, text: 'Created from schema defaults. Live now.' }
            : done === 'promoted'
              ? {
                  tone: 'done' as const,
                  text:
                    Number.isSafeInteger(count) && count >= 0
                      ? `Promoted ${count} key${count === 1 ? '' : 's'}. Live now.`
                      : 'Promoted. Live now.',
                }
              : done === 'deleted'
                ? {
                    tone: 'done' as const,
                    text:
                      Number.isSafeInteger(count) && count >= 0
                        ? `Removed ${count} key${count === 1 ? '' : 's'} from the schema and every environment.`
                        : 'Keys removed from the schema and every environment.',
                  }
                : done === 'keys-added'
                  ? {
                      tone: 'done' as const,
                      text:
                        Number.isSafeInteger(count) && count >= 0
                          ? `Added ${count} variable${count === 1 ? '' : 's'}. Live now.`
                          : 'Variables added. Live now.',
                    }
                  : undefined;
      return productPage(request, reply, request.params.service, environment, {}, notice);
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
      if (body.intent === 'create' && text(body.base) !== productBase(current.files, service)) {
        refused('config.ui.write.failed', {
          service,
          environment,
          code: 'conflict',
          detail: 'Product changed; review the defaults again.',
          status: 409,
        });
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          { tone: 'problem', text: 'Product changed; review the defaults again.' },
          409,
        );
      }
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
      if (body.intent !== 'create' && typeof body.etag !== 'string') {
        refused('config.ui.write.failed', {
          service,
          environment,
          code: 'conflict',
          detail: 'Reload this page before saving; its file version is missing.',
          status: 409,
        });
        return productPage(
          request,
          reply,
          service,
          environment,
          body,
          { tone: 'problem', text: 'Reload this page before saving; its file version is missing.' },
          409,
        );
      }
      const result = await operations.writeValues(
        {
          service,
          environment,
          changes: body.intent === 'create' ? current.schemas.defaultsFor(service) : changes,
          expectedEtag: body.intent === 'create' ? null : text(body.etag),
        },
        actor(request),
      );
      return resultPage(
        request,
        reply,
        service,
        environment,
        result,
        body,
        body.intent === 'create' ? 'created' : 'saved',
      );
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
    return resultPage(request, reply, service, result.ok ? to : from, result, body, 'promoted');
  });
  app.post(
    '/p/:service/delete-keys',
    async (request: FastifyRequest<{ Params: { service: string }; Body: Body }>, reply) => {
      const service = request.params.service;
      const body = request.body ?? {};
      const environment = text(body.environment);
      const keys = list(body.select);
      const current = await state();
      if (!keys.length || keys.some((key) => !current.schemas.definitionsFor(service).has(key))) {
        refused('config.ui.write.failed', {
          service,
          environment,
          code: 'invalid',
          detail: 'Select declared keys to remove.',
          status: 422,
        });
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          { tone: 'problem', text: 'Select declared keys to remove.' },
          422,
        );
      }
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
      return resultPage(request, reply, service, environment, result, body, 'deleted');
    },
  );
  app.post(
    '/p/:service/add-keys',
    async (request: FastifyRequest<{ Params: { service: string }; Body: Body }>, reply) => {
      const service = request.params.service;
      const body = request.body ?? {};
      const environment = text(body.environment);
      const typed = allKeyBodies(body);
      if (text(body.intent) === 'open-add-keys')
        return productPage(request, reply, service, environment, {}, undefined, 200, {}, {
          keyDrafts: typed.length ? typed : [{}],
        });
      if (text(body.intent) === 'add-key')
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          undefined,
          200,
          {},
          {
            keyDrafts: [...typed, {}],
          },
        );
      const keys = keyDrafts(body);
      const result = await operations.addKeys(
        { service, environment, keys, expectedEtag: text(body.etag) },
        actor(request),
      );
      if (!result.ok) {
        const presented = presentWriteFailure(result.error);
        refused('config.ui.write.failed', {
          service,
          environment,
          code: result.error.code,
          detail: result.error.detail,
          status: result.error.code === 'conflict' ? 409 : 422,
          ...problemFields(result.error.errors),
        });
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          presented.notice,
          result.error.code === 'conflict' ? 409 : 422,
          presented.byKey,
          { keyDrafts: typed.length ? typed : keyBodies(body), keyProblems: result.error.errors },
        );
      }
      return resultPage(request, reply, service, environment, result, body, 'keys-added');
    },
  );
  app.post(
    '/p/:service/retire',
    async (request: FastifyRequest<{ Params: { service: string }; Body: Body }>, reply) => {
      const service = request.params.service;
      const body = request.body ?? {};
      const retiring = body.retiring !== 'false';
      const environment =
        text(body.environment) ||
        new URLSearchParams(nextOf(request).split('?')[1] ?? '').get('env') ||
        undefined;
      if (retiring && body.confirm !== 'yes')
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          undefined,
          200,
          {},
          {
            retireAsk: 'confirm',
          },
        );
      const result = await operations.setRetiring(service, retiring, actor(request), {
        force: text(body.force) === 'yes',
      });
      if (!result.ok) {
        refused('config.ui.write.failed', {
          service,
          code: result.error.code,
          detail: result.error.detail,
          status: result.error.code === 'conflict' ? 409 : 422,
          ...problemFields(result.error.errors),
        });
        if (result.error.detail === ARCHIVE_ALREADY_EXISTS)
          return productPage(
            request,
            reply,
            service,
            environment,
            {},
            undefined,
            422,
            {},
            {
              retireAsk: 'force',
            },
          );
        return productPage(
          request,
          reply,
          service,
          environment,
          {},
          presentWriteFailure(result.error).notice,
          result.error.code === 'conflict' ? 409 : 422,
        );
      }
      await options.onCommitted?.();
      const stayOnRetiring = safeNextPath(text(body.next)).split('?')[0] === '/p/retiring';
      if (stayOnRetiring && isHtmx(request)) {
        reply.header('hx-push-url', '/p/retiring');
        return listProducts(request, reply, true);
      }
      return reply
        .code(303)
        .header('location', stayOnRetiring ? '/p/retiring' : `/p/${service}`)
        .send();
    },
  );
  app.post(
    '/p/:service/archive',
    async (request: FastifyRequest<{ Params: { service: string }; Body: Body }>, reply) => {
      const service = request.params.service;
      const body = request.body ?? {};
      reply.header('hx-push-url', '/p/retiring');
      if (body.confirm !== 'yes') {
        const current = await state();
        return listProducts(request, reply, true, {
          archiveAsk: {
            service,
            kind: 'confirm',
            base: productBase(current.files, service),
          },
        });
      }
      const result = await operations.archiveProduct(service, actor(request), text(body.base), {
        force: text(body.force) === 'yes',
      });
      if (!result.ok) {
        refused('config.ui.write.failed', {
          service,
          code: result.error.code,
          detail: result.error.detail,
          status: result.error.code === 'conflict' ? 409 : 422,
          ...problemFields(result.error.errors),
        });
        const status = result.error.code === 'conflict' ? 409 : 422;
        if (result.error.detail === ARCHIVE_ALREADY_EXISTS)
          return listProducts(request, reply, true, {
            archiveAsk: { service, kind: 'force', base: text(body.base) },
            status,
          });
        return listProducts(request, reply, true, {
          notice: presentWriteFailure(result.error).notice,
          status,
        });
      }
      await options.onCommitted?.();
      if (isHtmx(request)) return listProducts(request, reply, true);
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
    const current = await state();
    const typed = {
      name: service,
      uid: text(body.uid),
      environments: list(body.environment),
      keys: allKeyBodies(body),
    };
    if (text(body.intent) === 'add-key')
      return send(
        reply,
        renderNewProduct({
          ...common(request),
          environments: current.order.all(),
          typed: { ...typed, keys: [...typed.keys, {}] },
        }),
      );
    const keys = keyDrafts(body);
    const schema = buildSchema({ service, keys });
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
    if (!result.ok) {
      refused('config.ui.write.failed', {
        service,
        code: result.error.code,
        detail: result.error.detail,
        status: result.error.code === 'conflict' ? 409 : 422,
        ...problemFields(result.error.errors),
      });
      return send(
        reply,
        renderNewProduct({
          ...common(request),
          environments: current.order.all(),
          typed: { ...typed, keys: typed.keys.length ? typed.keys : keyBodies(body) },
          problems: result.error.errors ?? [{ key: '', message: result.error.detail }],
        }),
        result.error.code === 'conflict' ? 409 : 422,
      );
    }
    await options.onCommitted?.();
    return reply.code(303).header('location', `/p/${service}`).send();
  });
  app.get('/settings', async (request, reply) =>
    maySeeSettings(request)
      ? send(reply, renderSettings({ env: process.env, ...common(request) }))
      : reply.code(404).send('Not found'),
  );
  const declaredEnvironments = async () => (await state()).order.all();
  app.get('/sync', async (request, reply) => {
    if (!options.syncScheduler) return reply.code(404).send('Not found');
    if (options.syncScheduler.isAutoSync()) {
      if (isHtmx(request)) return send(reply, '');
      return reply.code(303).header('location', '/').send();
    }
    const pending = (await options.pendingSync?.()) ?? {
      entries: [],
      unpushed: [],
      ready: false,
    };
    if (!pending.ready) {
      if (isHtmx(request)) return send(reply, '');
      return reply.code(303).header('location', '/').send();
    }
    const current = await state();
    const changesByPath = await changelogByPath(pending.entries, current);
    const retiring = [...current.files.keys()]
      .map((path) => path.match(/^schema\/([^/]+)\.yaml$/)?.[1])
      .filter((name): name is string => Boolean(name))
      .filter((name) => current.schemas.isRetiring(name));
    return send(
      reply,
      renderSyncPreview({
        ...common(request),
        fragment: isHtmx(request),
        entries: pending.entries,
        unpushed: pending.unpushed,
        changesByPath,
        retiring,
      }),
    );
  });
  app.get('/sync/ack', async (request, reply) => {
    options.syncStatus?.clear();
    return reply
      .code(303)
      .header('location', safeNextPath(text((request.query as Body).next)))
      .send();
  });
  app.post('/sync', async (request, reply) => {
    if (!options.syncScheduler) return reply.code(404).send('Not found');
    if (text((request.body as Body | undefined)?.confirm) !== 'yes')
      return reply.code(303).header('location', '/sync').send();
    try {
      return afterSync(request, reply, await options.syncScheduler.syncNow());
    } catch (error) {
      logCaught(error, 'config.ui.sync.failed', { logger: 'routes.live-ui' });
      options.syncStatus?.noteError();
      return reply.code(303).header('location', '/?done=backup-failed').send();
    }
  });
  app.post('/sync/auto', async (request, reply) => {
    if (!options.syncScheduler || !options.autoSyncStore) return reply.code(404).send('Not found');
    const enabled = text((request.body as Body | undefined)?.autoSync) === 'true';
    await options.autoSyncStore.write(enabled);
    options.syncScheduler.setAutoSync(enabled);
    if (!enabled) {
      return reply.code(303).header('location', nextOf(request)).send();
    }
    try {
      return afterSync(request, reply, await options.syncScheduler.syncNow());
    } catch (error) {
      logCaught(error, 'config.ui.auto-sync.failed', { logger: 'routes.live-ui' });
      options.syncStatus?.noteError();
      const next = nextOf(request);
      return reply
        .code(303)
        .header('location', `${next.split('?')[0]}?done=backup-failed`)
        .send();
    }
  });
  registerFeatureRoutes(app, options, declaredEnvironments, common);
}
function registerFeatureRoutes(
  app: FastifyInstance,
  options: LiveUiOptions,
  declaredEnvironments: () => Promise<readonly string[]>,
  common: (request: FastifyRequest, extra?: Partial<LivePageOptions>) => LivePageOptions,
): void {
  app.get('/features', async (request, reply) => {
    if (!options.flagWriteService) return reply.code(404).send('Not found');
    const flags = await options.flagWriteService.all();
    const query = request.query as { env?: string };
    const environments = await declaredEnvironments();
    const environment = query.env?.trim() || environments[0] || '';
    if (environment && !environments.includes(environment))
      return reply.code(400).send('Unknown environment');
    return reply.type('text/html; charset=utf-8').send(
      String(
        renderFeatures({
          flags,
          environment,
          environments,
          ...common(request),
        }),
      ),
    );
  });

  app.get('/features/new', async (request, reply) => {
    if (!options.flagWriteService) return reply.code(404).send('Not found');
    const environments = await declaredEnvironments();
    const environment = (request.query as { env?: string }).env || environments[0] || '';
    if (!environments.includes(environment)) return reply.code(400).send('Unknown environment');
    return reply.type('text/html; charset=utf-8').send(String(renderFeatureAddRow(environment)));
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
      return reply.type('text/html; charset=utf-8').send(
        String(
          renderFeatures({
            flags,
            environment,
            environments,
            ...common(request),
          }),
        ),
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
      return reply.type('text/html; charset=utf-8').send(
        String(
          renderFeatures({
            flags,
            environment,
            environments,
            ...common(request),
          }),
        ),
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
