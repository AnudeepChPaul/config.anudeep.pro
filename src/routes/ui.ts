import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GitRepository } from '../git/repository.js';
import type { KeyDefinition, SchemaSet } from '../schema/validator.js';
import type { DraftStore } from '../store/draft-store.js';
import { EnvironmentOrder } from '../store/environment-order.js';
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
  /**
   * Which environment promotes into which. Read per request so a change to
   * `environments.yaml` takes effect without a restart; absent means promotion is not offered.
   */
  readonly environmentOrder?: () => Promise<EnvironmentOrder>;
}

interface NamespaceParams {
  service: string;
  environment: string;
}

/** Form field prefix. Everything else in the body is metadata, not configuration. */
const KEY_PREFIX = 'key.';

export function registerUiRoutes(app: FastifyInstance, options: UiRouteOptions): void {
  const { repository, loader, schemas, writeService, drafts } = options;
  const readOrder = options.environmentOrder ?? (async () => EnvironmentOrder.none());

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
        Querystring: { env?: string; notice?: string; published?: string };
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

      const elsewhere = environments
        .filter((env) => env.name !== active)
        .map((env) => ({
          environment: env.name,
          values: (tree.namespaces.get(env.namespace) ?? {}) as Record<string, unknown>,
          pending: env.pending,
        }));

      // The offer names exactly the keys that were just published, carried across the redirect
      // rather than recomputed — anything else could offer to move a change the operator did
      // not make.
      const published: string[] = (request.query?.published ?? '').split(',').filter(Boolean);
      const nextEnvironment = (await readOrder()).next(active);
      const schemaSet = schemas();
      const targetValues = nextEnvironment
        ? ((tree.namespaces.get(`${service}/${nextEnvironment}`) ?? {}) as Record<string, unknown>)
        : {};

      const offer =
        nextEnvironment && published.length > 0
          ? {
              nextEnvironment,
              movable: published
                .filter((key) => !schemaSet.isSecret(service, key))
                .map((key) => ({ key, value: committed[key], target: targetValues[key] })),
              blocked: published
                .filter((key) => schemaSet.isSecret(service, key))
                .map((key) => ({
                  key,
                  reason: `secret — set it directly in ${nextEnvironment}`,
                })),
            }
          : undefined;

      return reply.type('text/html; charset=utf-8').send(
        String(
          renderProduct({
            service,
            environments,
            active,
            rows: buildRows(schemaSet, service, shown, {}, {}, { committed, elsewhere }),
            commit: sources.commit,
            ...(request.query?.notice ? { notice: request.query.notice } : {}),
            ...(offer ? { offer } : {}),
          }),
        ),
      );
    },
  );

  app.post(
    '/p/:service/:environment',
    async (
      request: FastifyRequest<{
        Params: NamespaceParams;
        Body: Record<string, string | string[]>;
      }>,
      reply,
    ) => {
      const { service, environment } = request.params;
      const schemaSet = schemas();
      const submitted = collectSubmitted((request.body ?? {}) as Record<string, string | string[]>);
      const changes = coerceChanges(schemaSet, service, submitted);
      const session = request.session;

      const actor = {
        email: session?.email ?? 'unauthenticated@localhost',
        id: session?.id ?? 'anonymous',
        ...(session?.via ? { via: session.via } : {}),
      };
      const result = await writeService.stage({ service, environment, changes }, actor);

      if (result.ok) {
        const body = (request.body ?? {}) as Record<string, string | string[]>;
        const back = `/p/${service}?env=${encodeURIComponent(environment)}`;

        // Two buttons, one form: saving keeps the draft, publishing ships what is ticked.
        if (String(body.intent ?? '') !== 'publish') {
          return reply.code(303).header('location', back).send();
        }

        // Only ticks that are still staged. A stale tick — a key published from another tab
        // meanwhile — must not fail the whole publish.
        const staged = result.value.changes.map((change) => change.key);
        const ticked = toList(body.select).filter((key) => staged.includes(key));
        const keys = ticked.length > 0 ? ticked : staged;

        const published = await writeService.publish(
          [{ namespace: `${service}/${environment}`, keys }],
          String(body.message ?? '').trim() || `Publish ${service}/${environment}`,
          actor,
          { id: request.id, sourceIp: request.ip },
        );

        if (!published.ok) {
          return reply
            .code(303)
            .header('location', `${back}&notice=${encodeURIComponent(published.error.detail)}`)
            .send();
        }

        // The published keys ride the redirect so the promote offer names exactly them, rather
        // than recomputing a set that could include something the operator did not just ship.
        return reply
          .code(303)
          .header('location', `${back}&published=${encodeURIComponent(keys.join(','))}`)
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
    '/promote',
    async (request: FastifyRequest<{ Body: Record<string, string | string[]> }>, reply) => {
      const body = request.body ?? {};
      const service = String(body.service ?? '');
      const from = String(body.from ?? '');
      const to = String(body.to ?? '');
      const keys = toList(body.key);
      const session = request.session;

      const result = await writeService.promote(
        { service, from, to, keys },
        {
          email: session?.email ?? 'unauthenticated@localhost',
          id: session?.id ?? 'anonymous',
          ...(session?.via ? { via: session.via } : {}),
        },
      );

      // What actually landed, not what was asked for: a key whose value the target already
      // holds stages nothing, and claiming otherwise sends the operator looking for a change
      // that is not there.
      const notice = result.ok
        ? `Staged ${result.value.changes.length} change(s) in ${to}. Nothing is published there yet.`
        : `Nothing to promote: ${result.error.detail}`;

      // Lands on the target environment: the change is there to review, and that is where the
      // next decision is made.
      return reply
        .code(303)
        .header(
          'location',
          `/p/${service}?env=${encodeURIComponent(result.ok ? to : from)}&notice=${encodeURIComponent(notice)}`,
        )
        .send();
    },
  );

  app.post(
    '/publish',
    async (request: FastifyRequest<{ Body: Record<string, string | string[]> }>, reply) => {
      const body = request.body ?? {};
      const selected = toList(body.namespace);
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

/** One form field that may arrive once, many times, or not at all. */
function toList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

/** Every key the schema declares, plus any the file holds that it does not. */
interface RowContext {
  /** The committed values, so a staged edit can be shown as old -> new. */
  readonly committed?: Record<string, unknown>;
  /** Every other environment of this product: name -> its values and pending changes. */
  readonly elsewhere?: ReadonlyArray<{
    environment: string;
    values: Record<string, unknown>;
    pending: ReadonlyArray<{ key: string; from: unknown; to: unknown; secret: boolean }>;
  }>;
}

function buildRows(
  schemas: SchemaSet,
  service: string,
  config: Record<string, unknown>,
  errors: Record<string, string> = {},
  submitted: Record<string, string> = {},
  context: RowContext = {},
): KeyRow[] {
  const definitions = schemas.definitionsFor(service);
  const keys = new Set([...definitions.keys(), ...Object.keys(config)]);
  const committed = context.committed;

  return [...keys].sort().map((key) => {
    const definition: KeyDefinition | null = definitions.get(key) ?? null;
    const value = key in submitted ? submitted[key] : config[key];
    // Pending means the shown value differs from what is committed — the same comparison the
    // write path makes, so the marker cannot disagree with what a publish would do.
    const pending =
      committed !== undefined && JSON.stringify(committed[key]) !== JSON.stringify(value);

    return {
      key,
      definition,
      value,
      error: errors[key],
      ...(committed ? { publishedValue: committed[key], pending } : {}),
      elsewhere: (context.elsewhere ?? []).map((other) => {
        const change = other.pending.find((c) => c.key === key);
        return {
          environment: other.environment,
          value: change && !change.secret ? change.to : other.values[key],
          published: other.values[key],
          pending: Boolean(change),
        };
      }),
    };
  });
}

function collectSubmitted(body: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(body)
      .filter(([name]) => name.startsWith(KEY_PREFIX))
      // A checkbox is posted alongside a hidden `false`, so an unticked box still says false
      // rather than saying nothing — which the write path would read as "delete the override".
      // Both arrive; the later one is the checkbox's own value.
      .map(([name, value]) => [
        name.slice(KEY_PREFIX.length),
        Array.isArray(value) ? (value.at(-1) ?? '') : value,
      ]),
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
