import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GitRepository } from '../git/repository.js';
import { ServiceRegistry } from '../identity/registry.js';
import type { ServiceIdentity } from '../identity/types.js';
import type { KeyDefinition, SchemaSet } from '../schema/validator.js';
import type { DraftStore } from '../store/draft-store.js';
import { EnvironmentOrder } from '../store/environment-order.js';
import type { ConfigLoader } from '../store/loader.js';
import { isMetadataKey, versionOf } from '../store/metadata.js';
import type { ConfigWriteService } from '../store/write-service.js';
import {
  type EnvironmentSummary,
  type KeyRow,
  type PendingChange,
  type ProductSummary,
  renderDrafts,
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
  /**
   * The services the registry declares. The console lists exactly these — not what happens to
   * have a file in the tree — so a product appears when it is declared and not before.
   */
  readonly services?: () => readonly ServiceIdentity[];
  /**
   * The push remote's browser address, for linking the commit being served. Absent renders the
   * sha as plain text: a wrong link sends an operator mid-incident to somebody else's history.
   */
  readonly repoWebUrl?: string | null;
}

interface NamespaceParams {
  service: string;
  environment: string;
}

/**
 * htmx sets this on every request it makes.
 *
 * When present the handler answers with the page body alone, to be swapped in place; otherwise
 * it answers as it always did, with a document or a redirect a browser can follow on its own.
 */
const isHtmx = (request: FastifyRequest): boolean => request.headers['hx-request'] === 'true';

/** Form field prefix. Everything else in the body is metadata, not configuration. */
const KEY_PREFIX = 'key.';

export function registerUiRoutes(app: FastifyInstance, options: UiRouteOptions): void {
  const { repository, loader, schemas, writeService, drafts } = options;
  // Destructured here because productPage takes its own `options`, and the two would otherwise
  // read alike at the point of use.
  const repoWebUrl = options.repoWebUrl ?? null;
  /**
   * Read from the repository unless a caller supplies its own, and read per request so a change
   * to environments.yaml takes effect without a restart.
   *
   * This file decides what the console renders, not just what promotes into what: an environment
   * nobody declared has no tab, and a namespace whose environment is not declared is not shown.
   */
  const readOrder =
    options.environmentOrder ??
    (async () => {
      try {
        return EnvironmentOrder.fromYaml(await repository.readFile('environments.yaml'));
      } catch {
        return EnvironmentOrder.none();
      }
    });
  const declaredEnvironments = async () => (await readOrder()).all();
  /**
   * The services the repository declares, read per request so a change to services.yaml shows up
   * without a restart — the same rule the environment order follows.
   *
   * An unreadable or absent file lists nothing rather than falling back to whatever has a file in
   * the tree: a product nobody declared has no uid, so no process could read it anyway.
   */
  const declaredServices = async (): Promise<readonly ServiceIdentity[]> => {
    if (options.services) return options.services();
    try {
      return ServiceRegistry.fromYaml(await repository.readFile('services.yaml')).services();
    } catch {
      return [];
    }
  };

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
    // One press of Save is one draft, so what the console counts is saves, not keys.
    const draftsByNamespace = new Map<string, number>(
      staged.map((draft) => [draft.namespace, draft.saves.length]),
    );
    return { sources, tree, pendingByNamespace, draftsByNamespace };
  };

  /**
   * The environment tabs for a product: every environment `environments.yaml` declares, in the
   * declared order.
   *
   * Not what the tree happens to hold. Deriving them from the files meant an environment existed
   * on screen only after someone had already written to it, which is backwards — you open the
   * tab in order to write to it. An environment with no file yet renders with nothing set.
   */
  const environmentsOf = (
    service: string,
    environments: readonly string[],
    pending: Map<string, PendingChange[]>,
    draftSaves: Map<string, number> = new Map(),
  ): EnvironmentSummary[] =>
    environments.map((name) => ({
      name,
      namespace: `${service}/${name}`,
      pending: pending.get(`${service}/${name}`) ?? [],
      drafts: draftSaves.get(`${service}/${name}`) ?? 0,
    }));

  app.get('/drafts', async (request: FastifyRequest<{ Querystring: { notice?: string } }>, reply) =>
    reply.type('text/html; charset=utf-8').send(
      String(
        renderDrafts({
          drafts: (await drafts.all())
            .slice()
            .sort((a, b) => a.namespace.localeCompare(b.namespace))
            .map((draft) => ({
              namespace: draft.namespace,
              saves: draft.saves.map((save) => ({
                keys: [...save.keys],
                actor: save.actor,
                at: save.at,
              })),
            })),
          ...(request.query?.notice ? { notice: request.query.notice } : {}),
          fragment: isHtmx(request),
        }),
      ),
    ),
  );

  app.post(
    '/drafts/drop',
    async (request: FastifyRequest<{ Body: { namespace?: string; index?: string } }>, reply) => {
      const body = request.body ?? {};
      const session = request.session;
      const dropped = await writeService.dropSave(
        String(body.namespace ?? ''),
        Number(body.index ?? -1),
        {
          email: session?.email ?? 'unauthenticated@localhost',
          id: session?.id ?? 'anonymous',
          ...(session?.via ? { via: session.via } : {}),
        },
      );

      const notice = dropped.ok ? 'Draft dropped.' : dropped.error.detail;
      if (!isHtmx(request)) {
        return reply
          .code(303)
          .header('location', `/drafts?notice=${encodeURIComponent(notice)}`)
          .send();
      }

      return reply
        .header('hx-push-url', '/drafts')
        .type('text/html; charset=utf-8')
        .send(
          String(
            renderDrafts({
              drafts: (await drafts.all()).map((draft) => ({
                namespace: draft.namespace,
                saves: draft.saves.map((save) => ({
                  keys: [...save.keys],
                  actor: save.actor,
                  at: save.at,
                })),
              })),
              notice,
              fragment: true,
            }),
          ),
        );
    },
  );

  app.get(
    '/',
    async (request: FastifyRequest<{ Querystring: { notice?: string; q?: string } }>, reply) => {
      const { sources, tree, pendingByNamespace, draftsByNamespace } = await readState();

      // Declared, not discovered: a product is listed because services.yaml says it exists.
      const declared = await declaredServices();
      // Key NAMES only, from the schema. Searching values over a registry that holds secrets
      // becomes a way to confirm one by guessing, and "no match" is as informative as a match.
      const query = (request.query?.q ?? '').trim().toLowerCase();
      const environmentNames = await declaredEnvironments();
      const products: ProductSummary[] = declared.map((service) => {
        const environments = environmentsOf(
          service.name,
          environmentNames,
          pendingByNamespace,
          draftsByNamespace,
        );
        // The union across environments, not the first one's. Taking the first showed dev's keys
        // as if they were the product's, which is wrong whenever the environments differ — and
        // they usually do, since that is what having environments is for.
        const keys = [
          ...new Set(
            environments.flatMap((env) => Object.keys(tree.namespaces.get(env.namespace) ?? {})),
          ),
        ].sort();
        const matched = query
          ? [...schemas().definitionsFor(service.name).keys()]
              .filter((key) => key.toLowerCase().includes(query))
              .sort()
          : [];

        return {
          ...(query ? { matched } : {}),
          // The uid is what the read API authenticates against, so it belongs beside the name:
          // it is the fact that decides which process may read this product's configuration.
          name: `${service.name} (${service.uid})`,
          service: service.name,
          // A product with no schema cannot be edited at all: validate() refuses an unknown
          // service, so every save would fail at the last step, after the values were typed.
          schemaMissing: !schemas().has(service.name),
          keys: keys.slice(0, 3).join(', ') + (keys.length > 3 ? ` +${keys.length - 3}` : ''),
          environments,
        };
      });

      return reply.type('text/html; charset=utf-8').send(
        String(
          renderProducts({
            // A search shows only what matched; without one, everything declared.
            products: query
              ? products.filter((product) => (product.matched ?? []).length > 0)
              : products,
            ...(request.query?.q ? { query: request.query.q } : {}),
            commit: sources.commit,
            draftCount: [...draftsByNamespace.values()].reduce((total, n) => total + n, 0),
            ...(request.query?.notice ? { notice: request.query.notice } : {}),
          }),
        ),
      );
    },
  );

  /**
   * The product page, however it was asked for.
   *
   * GET renders it, and every POST answers with it when htmx asked — so a swap shows exactly
   * what a reload would. Two render paths would drift, and the drift would only show up for
   * whichever half nobody was looking at.
   */
  const productPage = async (options: {
    service: string;
    env?: string | undefined;
    notice?: string | undefined;
    /** The create-this-environment offer was declined; the action stays, the prompt goes. */
    offerDeclined?: boolean;
    /** Filters the fields to those whose key matches. Navigates nowhere. */
    query?: string | undefined;
    /** The key a search result linked to, marked so the eye lands on it. */
    highlight?: string | undefined;
    /** A confirmation the page clears itself, as opposed to something still to act on. */
    transientNotice?: boolean;
    published?: readonly string[];
    fragment: boolean;
  }): Promise<{ html: string; active: string } | null> => {
    const { service } = options;
    // Declared or nothing. With the tabs coming from environments.yaml rather than from the
    // files present, every service name would otherwise render a page — including one nobody
    // declared, which no process could ever read.
    if (!(await declaredServices()).some((entry) => entry.name === service)) return null;
    // No schema, no page. Rendering one would offer a form whose every submission is refused.
    if (!schemas().has(service)) return null;
    const { sources, tree, pendingByNamespace, draftsByNamespace } = await readState();
    const environments = environmentsOf(
      service,
      await declaredEnvironments(),
      pendingByNamespace,
      draftsByNamespace,
    );
    if (environments.length === 0) return null;

    const active =
      environments.find((env) => env.name === options.env)?.name ?? environments[0]?.name ?? '';
    const namespace = `${service}/${active}`;

    const draft = await drafts.get(namespace);
    const committed = (tree.namespaces.get(namespace) ?? {}) as Record<string, unknown>;
    const schemaSet = schemas();
    // Declared by environments.yaml but not written yet. Nothing is editable until the file
    // exists, so the page shows what it WOULD hold and offers to create it.
    const missingFile = !sources.sources.has(namespace) && !draft;
    const shown = draft
      ? await loader.resolveOne(namespace, draft.document)
      : missingFile
        ? schemaSet.defaultsFor(service)
        : committed;

    const elsewhere = environments
      .filter((env) => env.name !== active)
      .map((env) => ({
        environment: env.name,
        values: (tree.namespaces.get(env.namespace) ?? {}) as Record<string, unknown>,
        pending: env.pending,
      }));

    const published = options.published ?? [];
    const nextEnvironment = (await readOrder()).next(active);
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
              .map((key) => ({ key, reason: `secret — set it directly in ${nextEnvironment}` })),
          }
        : undefined;

    return {
      active,
      html: String(
        renderProduct({
          fragment: options.fragment,
          service,
          environments,
          active,
          rows: buildRows(
            schemaSet,
            service,
            shown,
            {},
            {},
            {
              committed,
              elsewhere,
              drafted: draft?.changes.map((change) => change.key) ?? [],
            },
          ),
          commit: sources.commit,
          repoWebUrl,
          drafted: draft?.changes.map((change) => change.key) ?? [],
          nextEnvironment,
          // What revision of this namespace the console is showing. Read from the draft when
          // there is one, since that is the document on screen.
          revision: versionOf(shown),
          ...(missingFile ? { missingFile: true } : {}),
          ...(options.query ? { query: options.query } : {}),
          ...(options.highlight ? { highlight: options.highlight } : {}),
          ...(options.offerDeclined ? { offerDeclined: true } : {}),
          // The audit trail's latest entry for this namespace, shown where the operator is
          // about to add to it.
          lastChange: await repository.lastChange(`config/${namespace}.yaml`),
          ...(options.notice ? { notice: options.notice } : {}),
          ...(options.transientNotice ? { transientNotice: true } : {}),
          ...(offer ? { offer } : {}),
        }),
      ),
    };
  };

  /**
   * Answers a form post: a swapped fragment for htmx, a redirect for a plain browser.
   *
   * The redirect is what makes the page work without the script — and it is also what stops a
   * reload from re-submitting the form, so it stays even now that most requests swap instead.
   */
  const respond = async (
    reply: FastifyReply,
    request: FastifyRequest,
    options: {
      service: string;
      env: string;
      notice?: string;
      transientNotice?: boolean;
      published?: readonly string[];
    },
  ) => {
    const back =
      `/p/${options.service}?env=${encodeURIComponent(options.env)}` +
      (options.notice ? `&notice=${encodeURIComponent(options.notice)}` : '') +
      // Survives the redirect, so the plain-browser path gets the same self-clearing
      // confirmation as the swapped one rather than a notice that stays until the next action.
      (options.transientNotice ? '&done=1' : '') +
      (options.published?.length
        ? `&published=${encodeURIComponent(options.published.join(','))}`
        : '');

    if (!isHtmx(request)) return reply.code(303).header('location', back).send();

    const page = await productPage({
      service: options.service,
      env: options.env,
      notice: options.notice,
      ...(options.transientNotice ? { transientNotice: true } : {}),
      published: options.published ?? [],
      fragment: true,
    });
    if (!page) return reply.code(404).type('text/html; charset=utf-8').send('Not found');

    return reply.header('hx-push-url', back).type('text/html; charset=utf-8').send(page.html);
  };

  app.get(
    '/p/:service',
    async (
      request: FastifyRequest<{
        Params: { service: string };
        Querystring: {
          env?: string;
          notice?: string;
          published?: string;
          done?: string;
          create?: string;
          q?: string;
          hl?: string;
        };
      }>,
      reply,
    ) => {
      const page = await productPage({
        service: request.params.service,
        env: request.query?.env,
        notice: request.query?.notice,
        ...(request.query?.done ? { transientNotice: true } : {}),
        ...(request.query?.create === 'no' ? { offerDeclined: true } : {}),
        query: request.query?.q,
        highlight: request.query?.hl,
        published: (request.query?.published ?? '').split(',').filter(Boolean),
        fragment: isHtmx(request),
      });

      if (!page) return reply.code(404).type('text/html; charset=utf-8').send('Not found');

      // The address bar has to follow the swap, or a reload lands somewhere other than what the
      // screen is showing.
      if (isHtmx(request)) {
        reply.header(
          'hx-push-url',
          `/p/${request.params.service}?env=${encodeURIComponent(page.active)}`,
        );
      }

      return reply.type('text/html; charset=utf-8').send(page.html);
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
      const body = (request.body ?? {}) as Record<string, string | string[]>;
      const session = request.session;

      const actor = {
        email: session?.email ?? 'unauthenticated@localhost',
        id: session?.id ?? 'anonymous',
        ...(session?.via ? { via: session.via } : {}),
      };
      if (String(body.intent ?? '') === 'create') {
        // One draft holding the schema's defaults: reviewable on the draft list, droppable, and
        // committed with a generated message like anything else.
        const created = await writeService.stage(
          { service, environment, changes: schemaSet.defaultsFor(service) },
          actor,
        );
        return respond(reply, request, {
          service,
          env: environment,
          ...(created.ok
            ? {
                notice: `Drafted ${service}/${environment}.yaml from the schema defaults.`,
                transientNotice: true,
              }
            : { notice: created.error.detail }),
        });
      }

      const publishing = String(body.intent ?? '') === 'publish';
      const result = await writeService.stage(
        {
          service,
          environment,
          changes,
          // On a save the ticks travel with the values: a tick on a key whose value has not
          // moved is still a statement of intent, and one the draft has to keep. On a publish
          // they choose the scope of the commit instead — recording them as a revision would
          // bump the counter every time anything is published.
          ...(publishing ? {} : { selected: toList(body.select) }),
        },
        actor,
      );

      if (result.ok) {
        // Two buttons, one form: saving keeps the draft, publishing ships what is ticked.
        if (!publishing) {
          return respond(reply, request, { service, env: environment });
        }

        // The whole draft is published — a draft publishes whole, and its commit message is
        // generated from the saves that made it. The ticks still say what should MOVE ON to the
        // next environment, which is the one thing they are still for.
        const inDraft = result.value.changes.map((change) => change.key);
        const ticked = toList(body.select).filter((key) => inDraft.includes(key));
        const keys = ticked.length > 0 ? ticked : inDraft;

        const published = await writeService.publish(
          [{ namespace: `${service}/${environment}` }],
          actor,
          { id: request.id, sourceIp: request.ip },
        );

        if (!published.ok) {
          return respond(reply, request, {
            service,
            env: environment,
            notice: published.error.detail,
          });
        }

        // The published keys are carried through so the promote offer names exactly them,
        // rather than recomputing a set that could include something not just shipped.
        //
        // A publish that did not reach the remote is NOT a transient confirmation: the commit is
        // durable and being served, but it is backed up nowhere, and a page that erases the only
        // report of that after five seconds is worse than one that never said it.
        return respond(reply, request, {
          service,
          env: environment,
          published: keys,
          notice: published.value.published
            ? 'Done publishing.'
            : 'Done publishing — not yet pushed to GitHub.',
          ...(published.value.published ? { transientNotice: true } : {}),
        });
      }

      // A tick is a statement of intent, not an edit, so ticking keys and saving is a normal
      // thing to do and simply has nothing to write down. It is not a validation failure: the
      // 422 branch below renders a per-key error page, which here had no per-key errors on it.
      if (result.error.code === 'nothing_staged') {
        return respond(reply, request, {
          service,
          env: environment,
          notice: 'Nothing to save — no value was edited and nothing was ticked.',
        });
      }

      const { sources, tree, pendingByNamespace, draftsByNamespace } = await readState();
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
              environments: environmentsOf(
                service,
                await declaredEnvironments(),
                pendingByNamespace,
                draftsByNamespace,
              ),
              active: environment,
              // Submitted values, not stored ones: retyping a form mid-incident is how the
              // wrong value gets entered the second time.
              rows: buildRows(
                schemaSet,
                service,
                { ...(tree.namespaces.get(`${service}/${environment}`) ?? {}), ...changes },
                perKey,
                submitted,
                // With the committed values in hand the rows keep their ticks, so a corrected
                // value can be saved without re-ticking everything that was already selected.
                { committed: tree.namespaces.get(`${service}/${environment}`) ?? {} },
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
      return respond(reply, request, { service, env: result.ok ? to : from, notice });
    },
  );

  app.post(
    '/publish',
    async (request: FastifyRequest<{ Body: Record<string, string | string[]> }>, reply) => {
      const body = request.body ?? {};
      const selected = toList(body.namespace);
      const session = request.session;

      // A product checkbox on the index selects the product; the namespaces it stands for are
      // resolved here rather than posted, so a hand-edited form cannot name someone else's.
      const { pendingByNamespace, draftsByNamespace } = await readState();
      const environmentNames = await declaredEnvironments();
      const namespaces = selected.flatMap((entry) =>
        entry.includes('/')
          ? [entry]
          : environmentsOf(entry, environmentNames, pendingByNamespace, draftsByNamespace)
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
  /** Keys the draft holds. A tick-only selection moves no value, so it cannot be inferred. */
  readonly drafted?: readonly string[];
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
  // Metadata the file carries about itself is not an editable key: a row for it would invite
  // editing a counter the write path maintains, and there is no definition to render it with.
  const keys = new Set(
    [...definitions.keys(), ...Object.keys(config)].filter((key) => !isMetadataKey(key)),
  );
  const committed = context.committed;

  return [...keys].sort().map((key) => {
    const definition: KeyDefinition | null = definitions.get(key) ?? null;
    const value = key in submitted ? submitted[key] : config[key];
    // Pending means the shown value differs from what is committed — the same comparison the
    // write path makes, so the marker cannot disagree with what a publish would do — or the
    // draft names the key. A tick-only selection moves no value, and comparing values alone
    // would show it as untouched and publish nothing.
    const pending =
      (context.drafted ?? []).includes(key) ||
      (committed !== undefined && JSON.stringify(committed[key]) !== JSON.stringify(value));

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
