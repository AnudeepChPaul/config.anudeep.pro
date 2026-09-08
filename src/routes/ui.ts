import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GitRepository } from '../git/repository.js';
import type { KeyDefinition, SchemaSet } from '../schema/validator.js';
import type { DraftStore } from '../store/draft-store.js';
import type { ConfigLoader } from '../store/loader.js';
import type { ConfigWriteService } from '../store/write-service.js';
import {
  type EnvironmentSummary,
  type KeyRow,
  type PendingChange,
  type ProductSummary,
  renderProduct,
  renderProducts,
} from '../views/pages.js';

/**
 * The CRUD UI.
 *
 * Rendered on the server, posted as a form, answered with a redirect. The editor is used during
 * incidents, so the design goal is that nothing needs to load before it works.
 */

export interface UiRouteOptions {
  readonly repository: GitRepository;
  readonly loader: ConfigLoader;
  readonly schemas: () => SchemaSet;
  readonly writeService: ConfigWriteService;
  readonly drafts: DraftStore;
}

interface NamespaceParams {
  service: string;
  environment: string;
}

/** Form field prefix. Everything else in the body is metadata, not configuration. */
const KEY_PREFIX = 'key.';

export function registerUiRoutes(app: FastifyInstance, options: UiRouteOptions): void {
  const { repository, loader, schemas, writeService, drafts } = options;

  /**
   * What the console renders from: the committed tree, plus whatever is staged on top of it.
   *
   * Both are needed on every page — a namespace shows its live values and the fact that some
   * of them have a pending edit — so they are read together rather than by each handler.
   */
  const readState = async () => {
    const sources = await repository.readSources();
    const tree = await loader.resolve(sources);
    const staged = await drafts.all();
    const pendingByNamespace = new Map<string, PendingChange[]>(
      staged.map((draft) => [draft.namespace, [...draft.changes]]),
    );
    return { sources, tree, pendingByNamespace };
  };

  const environmentsOf = (
    service: string,
    namespaces: Iterable<string>,
    pending: Map<string, PendingChange[]>,
  ): EnvironmentSummary[] =>
    [...namespaces]
      .filter((namespace) => namespace.startsWith(`${service}/`))
      .sort()
      .map((namespace) => ({
        name: namespace.slice(service.length + 1),
        namespace,
        pending: pending.get(namespace) ?? [],
      }));

  app.get('/', async (request: FastifyRequest<{ Querystring: { notice?: string } }>, reply) => {
    const { sources, tree, pendingByNamespace } = await readState();

    const services = [...new Set([...sources.sources.keys()].map((ns) => ns.split('/')[0] ?? ''))];
    const products: ProductSummary[] = services.sort().map((service) => {
      const environments = environmentsOf(service, sources.sources.keys(), pendingByNamespace);
      // The union across environments, not the first one's. Taking the first showed dev's keys
      // as if they were the product's, which is wrong whenever the environments differ — and
      // they usually do, since that is what having environments is for.
      const keys = [
        ...new Set(
          environments.flatMap((env) => Object.keys(tree.namespaces.get(env.namespace) ?? {})),
        ),
      ].sort();
      return {
        name: service,
        keys: keys.slice(0, 3).join(', ') + (keys.length > 3 ? ` +${keys.length - 3}` : ''),
        environments,
      };
    });

    return reply.type('text/html; charset=utf-8').send(
      String(
        renderProducts({
          products,
          commit: sources.commit,
          ...(request.query?.notice ? { notice: request.query.notice } : {}),
        }),
      ),
    );
  });

  app.get(
    '/p/:service',
    async (
      request: FastifyRequest<{
        Params: { service: string };
        Querystring: { env?: string; notice?: string };
      }>,
      reply,
    ) => {
      const { service } = request.params;
      const { sources, tree, pendingByNamespace } = await readState();
      const environments = environmentsOf(service, sources.sources.keys(), pendingByNamespace);

      if (environments.length === 0) {
        return reply.code(404).type('text/html; charset=utf-8').send('Not found');
      }

      // An unknown ?env is not an error worth a 404 — it is a stale bookmark. The first
      // environment is a better answer than a dead end.
      const active =
        environments.find((env) => env.name === request.query?.env)?.name ??
        environments[0]?.name ??
        '';
      const namespace = `${service}/${active}`;

      // Values shown are the staged ones where a draft exists: the editor should show what
      // will be published, not what was published last.
      const draft = await drafts.get(namespace);
      const committed = tree.namespaces.get(namespace) ?? {};
      const shown = draft ? await loader.resolveOne(namespace, draft.document) : committed;

      return reply.type('text/html; charset=utf-8').send(
        String(
          renderProduct({
            service,
            environments,
            active,
            rows: buildRows(schemas(), service, shown),
            commit: sources.commit,
            ...(request.query?.notice ? { notice: request.query.notice } : {}),
          }),
        ),
      );
    },
  );

  app.post(
    '/p/:service/:environment',
    async (
      request: FastifyRequest<{ Params: NamespaceParams; Body: Record<string, string> }>,
      reply,
    ) => {
      const { service, environment } = request.params;
      const schemaSet = schemas();
      const submitted = collectSubmitted(request.body ?? {});
      const changes = coerceChanges(schemaSet, service, submitted);
      const session = request.session;

      const result = await writeService.stage(
        { service, environment, changes },
        {
          email: session?.email ?? 'unauthenticated@localhost',
          id: session?.id ?? 'anonymous',
          ...(session?.via ? { via: session.via } : {}),
        },
      );

      if (result.ok) {
        return reply
          .code(303)
          .header('location', `/p/${service}?env=${encodeURIComponent(environment)}`)
          .send();
      }

      const { sources, tree, pendingByNamespace } = await readState();
      const perKey = Object.fromEntries(
        (result.error.errors ?? []).map((error) => [error.key, error.message]),
      );
      return reply
        .code(422)
        .type('text/html; charset=utf-8')
        .send(
          String(
            renderProduct({
              service,
              environments: environmentsOf(service, sources.sources.keys(), pendingByNamespace),
              active: environment,
              // Submitted values, not stored ones: retyping a form mid-incident is how the
              // wrong value gets entered the second time.
              rows: buildRows(
                schemaSet,
                service,
                { ...(tree.namespaces.get(`${service}/${environment}`) ?? {}), ...changes },
                perKey,
                submitted,
              ),
              commit: sources.commit,
              error: result.error.detail,
            }),
          ),
        );
    },
  );

  app.post(
    '/publish',
    async (request: FastifyRequest<{ Body: Record<string, string | string[]> }>, reply) => {
      const body = request.body ?? {};
      const raw = body.namespace;
      const selected = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
      const message = String(body.message ?? '').trim();
      const session = request.session;

      // A product checkbox on the index selects the product; the namespaces it stands for are
      // resolved here rather than posted, so a hand-edited form cannot name someone else's.
      const { sources, pendingByNamespace } = await readState();
      const namespaces = selected.flatMap((entry) =>
        entry.includes('/')
          ? [entry]
          : environmentsOf(entry, sources.sources.keys(), pendingByNamespace)
              .filter((env) => env.pending.length > 0)
              .map((env) => env.namespace),
      );

      if (namespaces.length === 0) {
        return reply
          .code(303)
          .header('location', '/?notice=Nothing%20selected%20had%20unpublished%20changes.')
          .send();
      }

      const result = await writeService.publish(
        namespaces,
        message || `Publish ${namespaces.join(', ')}`,
        {
          email: session?.email ?? 'unauthenticated@localhost',
          id: session?.id ?? 'anonymous',
          ...(session?.via ? { via: session.via } : {}),
        },
        { id: request.id, sourceIp: request.ip },
      );

      const notice = result.ok
        ? `Published ${result.value.changedKeys.length} change(s)${result.value.published ? '' : ' — not yet pushed to GitHub'}.`
        : result.error.detail;

      return reply
        .code(303)
        .header('location', `/?notice=${encodeURIComponent(notice)}`)
        .send();
    },
  );
}

/** Every key the schema declares, plus any the file holds that it does not. */
function buildRows(
  schemas: SchemaSet,
  service: string,
  config: Record<string, unknown>,
  errors: Record<string, string> = {},
  submitted: Record<string, string> = {},
): KeyRow[] {
  const definitions = schemas.definitionsFor(service);
  const keys = new Set([...definitions.keys(), ...Object.keys(config)]);

  return [...keys].sort().map((key) => {
    const definition: KeyDefinition | null = definitions.get(key) ?? null;
    const value = key in submitted ? submitted[key] : config[key];
    return { key, definition, value, error: errors[key] };
  });
}

function collectSubmitted(body: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(body)
      .filter(([name]) => name.startsWith(KEY_PREFIX))
      .map(([name, value]) => [name.slice(KEY_PREFIX.length), value]),
  );
}

/**
 * Turns form strings into typed values.
 *
 * A blank non-secret field deletes the override, returning the key to the service's compiled-in
 * default. A blank *secret* field is left alone instead: the form never shows the current
 * secret, so blank means "unchanged", and treating it as a deletion would wipe a password every
 * time an operator edited an unrelated flag on the same page.
 */
function coerceChanges(
  schemas: SchemaSet,
  service: string,
  submitted: Record<string, string>,
): Record<string, unknown> {
  const definitions = schemas.definitionsFor(service);
  const changes: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(submitted)) {
    const definition = definitions.get(key);
    const text = raw.trim();

    if (definition?.secret && text === '') continue;
    if (text === '') {
      changes[key] = undefined;
      continue;
    }

    switch (definition?.type) {
      case 'int': {
        const parsed = Number(text);
        // Left as the raw string when it is not a number, so the schema validator reports it
        // rather than this function silently turning it into NaN.
        changes[key] = Number.isFinite(parsed) ? parsed : text;
        break;
      }
      case 'bool':
        changes[key] = text === 'true' || text === 'on';
        break;
      case 'string[]':
        changes[key] = text
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      default:
        changes[key] = text;
    }
  }

  return changes;
}
