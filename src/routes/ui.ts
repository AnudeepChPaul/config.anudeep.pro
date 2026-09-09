import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildInfo, buildLabel } from '../build-info.js';
import type { GitRepository } from '../git/repository.js';
import { ServiceRegistry } from '../identity/registry.js';
import type { ServiceIdentity } from '../identity/types.js';
import { buildSchema, type KeyDraft } from '../schema/builder.js';
import type { KeyDefinition, SchemaSet } from '../schema/validator.js';
import type { DraftStore } from '../store/draft-store.js';
import { EnvironmentOrder } from '../store/environment-order.js';
import type { ConfigLoader } from '../store/loader.js';
import { isMetadataKey, versionOf } from '../store/metadata.js';
import type { ConfigWriteService } from '../store/write-service.js';
import { noticeFor } from '../views/notices.js';
import {
  type EnvironmentSummary,
  type KeyRow,
  type PageNotice,
  type PendingChange,
  type ProductSummary,
  renderDrafts,
  renderNewProduct,
  renderProduct,
  renderProducts,
  renderSettings,
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
  /**
   * The settings page: whether it exists, and who may see it beside a break-glass session.
   *
   * Absent means it does not exist, which is the default a page showing a map of the deployment
   * should have. `allow` empty admits nobody rather than everybody: an allowlist whose empty case
   * means "everyone" is a disclosure the first time someone enables the toggle and stops reading.
   */
  readonly settings?: { readonly enabled: boolean; readonly allow: readonly string[] };
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

  /**
   * Who may see how this service is configured.
   *
   * Both refusals are a 404, never a 403. A 403 says "there is a settings page and you may not
   * have it", which is a fact about the deployment worth withholding from anyone who is not
   * already trusted with the rest of it.
   */
  // Read once. None of it changes while this process runs, and reading os.hostname() per render
  // would be a syscall for a string that is constant.
  const build = buildLabel(buildInfo());

  const maySeeSettings = (request: FastifyRequest): boolean => {
    const settings = options.settings;
    if (!settings?.enabled) return false;
    const session = request.session;
    if (!session) return false;
    // Break-glass is the credential of last resort and is used when iam is unreachable, which is
    // exactly when someone needs to know what this service is configured with.
    if (session.via === 'break-glass') return true;
    return settings.allow.includes(session.email.trim().toLowerCase());
  };

  /**
   * Declaring a product.
   *
   * The form is rendered from the declared environments, and every field it collects is checked
   * again when it comes back: the inputs are a convenience, the POST body is user input.
   */
  // `/p/new`, beside `/p/iam` and `/p/audit`: adding a product is where products are.
  //
  // Fastify matches a static segment before a parameter, so this wins over `/p/:service` and a
  // product could never be reached at this address — which is why 'new' is a reserved name and
  // the form refuses it below.
  app.get('/p/new', async (request: FastifyRequest, reply) =>
    reply.type('text/html; charset=utf-8').send(
      String(
        renderNewProduct({
          environments: await declaredEnvironments(),
          settingsLink: maySeeSettings(request),
          build,
          fragment: isHtmx(request),
        }),
      ),
    ),
  );

  app.post(
    '/p/new',
    async (request: FastifyRequest<{ Body: Record<string, string | string[]> }>, reply) => {
      const body = request.body ?? {};
      const name = String(body.name ?? '').trim();
      const uid = String(body.uid ?? '').trim();
      const environments = toList(body.environment);
      const keys = keyDrafts(body);

      const problems: Array<{ key: string; message: string }> = [];
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        problems.push({
          key: '',
          message: `'${name}' is not a valid product name: lower case, letters, digits and hyphens`,
        });
      }
      // The form lives at /p/new, and Fastify matches a static segment before a parameter, so a
      // product called 'new' would have a page nothing could ever reach. Refused here rather
      // than discovered by whoever first tries to open it.
      if (name === 'new') {
        problems.push({ key: '', message: "'new' is reserved: it is the address of this form" });
      }
      // Not Number(): an empty string is 0, and 0 is a real uid — root's.
      if (!/^\d+$/.test(uid)) {
        problems.push({ key: '', message: 'uid must be a whole, non-negative number' });
      }
      if (environments.length === 0) {
        problems.push({ key: '', message: 'choose at least one environment' });
      }

      const schema = buildSchema({ service: name, keys });
      if (!schema.ok) problems.push(...schema.error);

      const typed = {
        name,
        uid,
        environments,
        keys: keyBodies(body),
      };

      if (problems.length > 0 || !schema.ok) {
        return reply
          .code(422)
          .header('hx-retarget', '#page')
          .header('hx-reswap', 'innerHTML')
          .type('text/html; charset=utf-8')
          .send(
            String(
              renderNewProduct({
                environments: await declaredEnvironments(),
                draft: typed,
                problems,
                settingsLink: maySeeSettings(request),
                build,
                fragment: isHtmx(request),
              }),
            ),
          );
      }

      const session = request.session;
      const staged = await writeService.stageProduct(
        {
          service: name,
          uid: Number(uid),
          environments,
          schema: schema.value,
          // What the schema declares, minus the secrets: a secret is created without a value.
          defaults: defaultsOf(keys),
        },
        {
          email: session?.email ?? 'unauthenticated@localhost',
          id: session?.id ?? 'anonymous',
          ...(session?.via ? { via: session.via } : {}),
        },
      );

      if (!staged.ok) {
        return reply
          .code(422)
          .header('hx-retarget', '#page')
          .header('hx-reswap', 'innerHTML')
          .type('text/html; charset=utf-8')
          .send(
            String(
              renderNewProduct({
                environments: await declaredEnvironments(),
                draft: typed,
                problems: [{ key: '', message: staged.error.detail }],
                settingsLink: maySeeSettings(request),
                build,
                fragment: isHtmx(request),
              }),
            ),
          );
      }

      if (!isHtmx(request)) {
        return reply.code(303).header('location', '/?done=drafted&n=1').send();
      }
      return reply.header('hx-redirect', '/?done=drafted&n=1').code(204).send();
    },
  );

  app.get('/settings', async (request: FastifyRequest, reply) => {
    if (!maySeeSettings(request)) {
      return reply.code(404).type('text/html; charset=utf-8').send('Not found');
    }

    return reply
      .type('text/html; charset=utf-8')
      .send(String(renderSettings({ env: process.env, build, fragment: isHtmx(request) })));
  });

  app.get(
    '/drafts',
    async (request: FastifyRequest<{ Querystring: { done?: string; n?: string } }>, reply) =>
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
            ...noticeQuery(request.query),
            // The link comes from the same answer that gates the route. Two predicates would
            // drift, and the way they drift is a link that leads to a 404.
            settingsLink: maySeeSettings(request),
            build,
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

      // A code, not a sentence: the wording lives in views/notices.ts, so nothing a URL carries
      // can put words on the page. The detail of a failed drop is logged, not shown to a link.
      const code = dropped.ok ? 'dropped' : 'drop-failed';
      const notice = noticeFor(code) ?? undefined;
      if (!isHtmx(request)) {
        return reply.code(303).header('location', `/drafts?done=${code}`).send();
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
              ...(notice ? { notice } : {}),
              fragment: true,
            }),
          ),
        );
    },
  );

  app.get(
    '/',
    async (
      request: FastifyRequest<{ Querystring: { done?: string; n?: string; q?: string } }>,
      reply,
    ) => {
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

      /**
       * A product that only a draft declares.
       *
       * The list is built from services.yaml, and a product being CREATED is not in there yet:
       * its entry is inside the draft. Its draft therefore had nothing to be counted against,
       * so the page said "1 unpublished draft" and "nothing unpublished" in the same line, and
       * offered no way to publish the product it had just been asked to create.
       */
      const declaredNames = new Set(declared.map((service) => service.name));
      const drafted = new Map<string, string[]>();
      for (const namespace of draftsByNamespace.keys()) {
        const [service, environment] = namespace.split('/');
        if (!service || !environment || declaredNames.has(service)) continue;
        drafted.set(service, [...(drafted.get(service) ?? []), environment]);
      }
      for (const [service, environments] of drafted) {
        products.push({
          // No uid to show: it is in the draft, not in the grant table, and printing one from an
          // unpublished file would state as fact something no process can act on yet.
          name: service,
          service,
          keys: 'not published yet',
          notDeclared: true,
          environments: environments.map((environment) => ({
            name: environment,
            namespace: `${service}/${environment}`,
            pending: pendingByNamespace.get(`${service}/${environment}`) ?? [],
            drafts: draftsByNamespace.get(`${service}/${environment}`) ?? 0,
          })),
        });
      }

      // htmx swaps the CONTENTS of #page, so a response that carries its own frame puts one
      // <main id="page"> inside another and applies the frame's padding and width twice — the
      // page moved inward and down on every navigation back to this list, and again on the next.
      if (isHtmx(request))
        reply.header('hx-push-url', query ? `/?q=${encodeURIComponent(query)}` : '/');

      return reply.type('text/html; charset=utf-8').send(
        String(
          renderProducts({
            fragment: isHtmx(request),
            // A search shows only what matched; without one, everything declared.
            products: query
              ? products.filter((product) => (product.matched ?? []).length > 0)
              : products,
            ...(request.query?.q ? { query: request.query.q } : {}),
            commit: sources.commit,
            draftCount: [...draftsByNamespace.values()].reduce((total, n) => total + n, 0),
            ...noticeQuery(request.query),
            settingsLink: maySeeSettings(request),
            build,
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
    notice?: PageNotice | undefined;
    /** The create-this-environment offer was declined; the action stays, the prompt goes. */
    offerDeclined?: boolean;
    /** Filters the fields to those whose key matches. Navigates nowhere. */
    query?: string | undefined;
    /** The key a search result linked to, marked so the eye lands on it. */
    highlight?: string | undefined;
    /** True when this viewer may open the settings page; the footer link follows the gate. */
    settingsLink?: boolean;
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
          // Declared, but with nothing behind them. Computed from what the tree actually holds
          // rather than from the tabs, so an environment stops being offered the moment its file
          // exists — including one created by a draft that has not been published.
          creatable: environments
            .filter(
              (env) => !sources.sources.has(env.namespace) && !draftsByNamespace.has(env.namespace),
            )
            .map((env) => env.name),
          ...(options.query ? { query: options.query } : {}),
          ...(options.highlight ? { highlight: options.highlight } : {}),
          ...(options.offerDeclined ? { offerDeclined: true } : {}),
          // The audit trail's latest entry for this namespace, shown where the operator is
          // about to add to it.
          lastChange: await repository.lastChange(`config/${namespace}.yaml`),
          ...(options.notice ? { notice: options.notice } : {}),
          ...(options.settingsLink ? { settingsLink: true } : {}),
          build,
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
      /** The outcome, as a code this console knows how to word. Never a sentence. */
      done?: string;
      /** What the code counts, when it counts something. */
      n?: number;
      published?: readonly string[];
    },
  ) => {
    // The URL names an outcome; views/notices.ts owns what that outcome SAYS. Free text here
    // meant a link could render any message inside the console, and meant a stale confirmation
    // replayed on every reload of the address it left behind.
    const back =
      `/p/${options.service}?env=${encodeURIComponent(options.env)}` +
      (options.done ? `&done=${encodeURIComponent(options.done)}` : '') +
      (options.n === undefined ? '' : `&n=${options.n}`) +
      (options.published?.length
        ? `&published=${encodeURIComponent(options.published.join(','))}`
        : '');

    if (!isHtmx(request)) return reply.code(303).header('location', back).send();

    const notice = noticeFor(options.done, options.n === undefined ? {} : { n: options.n });
    const page = await productPage({
      service: options.service,
      env: options.env,
      settingsLink: maySeeSettings(request),
      ...(notice ? { notice } : {}),
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
          published?: string;
          done?: string;
          n?: string;
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
        settingsLink: maySeeSettings(request),
        ...noticeQuery(request.query),
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
        // A code, like every other outcome. This branch went on passing `notice` and
        // `transientNotice` long after respond() stopped having them: TypeScript does not
        // excess-property-check a SPREAD, so it compiled, and creating an environment reported
        // nothing at all.
        return respond(reply, request, {
          service,
          env: environment,
          done: created.ok ? 'created' : 'create-failed',
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
        //
        // A save says what it saved. It used to say nothing at all, so the only evidence that
        // the most frequent write in the console had worked was the publish action appearing --
        // and when a save staged nothing, the two outcomes were indistinguishable.
        //
        // The count is what was WRITTEN DOWN, not what was posted: a key submitted at the value
        // it already holds stages nothing, and saying otherwise sends the operator looking for a
        // change that is not in the draft.
        if (!publishing) {
          return respond(reply, request, {
            service,
            env: environment,
            done: 'drafted',
            n: result.value.changes.length,
          });
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
            done: published.error.code === 'conflict' ? 'publish-stale' : 'publish-failed',
          });
        }

        // The published keys are carried through so the promote offer names exactly them,
        // rather than recomputing a set that could include something not just shipped.
        //
        // A publish that did not reach the remote is NOT a transient confirmation: the commit is
        // durable and being served, but it is backed up nowhere, and a page that erases the only
        // report of that after five seconds is worse than one that never said it.
        // A publish that did not reach the remote is not a confirmation: the commit is durable
        // and being served, but it is backed up nowhere, and the notice's own tone keeps it on
        // the page instead of erasing the only report of it after five seconds.
        return respond(reply, request, {
          service,
          env: environment,
          published: keys,
          done: published.value.published ? 'published' : 'published-unpushed',
          n: keys.length,
        });
      }

      // A tick is a statement of intent, not an edit, so ticking keys and saving is a normal
      // thing to do and simply has nothing to write down. It is not a validation failure: the
      // 422 branch below renders a per-key error page, which here had no per-key errors on it.
      if (result.error.code === 'nothing_staged') {
        return respond(reply, request, { service, env: environment, done: 'nothing-staged' });
      }

      const { sources, tree, pendingByNamespace, draftsByNamespace } = await readState();
      const perKey = Object.fromEntries(
        (result.error.errors ?? []).map((error) => [error.key, error.message]),
      );
      return (
        reply
          .code(422)
          // The status stays honest — a refused save is not a 200 — and these two headers are how
          // htmx is told to swap it anyway. Without them it swaps nothing on a non-2xx, so the
          // spinner stopped, the page did not change, and the value looked accepted.
          .header('hx-retarget', '#page')
          .header('hx-reswap', 'innerHTML')
          .type('text/html; charset=utf-8')
          .send(
            String(
              renderProduct({
                // A fragment when htmx asked, or the swap injects a whole document into #page.
                fragment: isHtmx(request),
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
          )
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
      const done = result.ok ? 'promoted' : 'promote-failed';

      // Lands on the target environment: the change is there to review, and that is where the
      // next decision is made.
      return respond(reply, request, {
        service,
        env: result.ok ? to : from,
        done,
        ...(result.ok ? { n: result.value.changes.length } : {}),
      });
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
        return reply.code(303).header('location', '/?done=nothing-selected').send();
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

      // A code and a count. The wording is the console's, so a link cannot speak in its voice,
      // and a reload of the address this leaves behind cannot replay a stale confirmation as
      // though it had just happened.
      const done = result.ok
        ? result.value.published
          ? 'published'
          : 'published-unpushed'
        : result.error.code === 'conflict'
          ? 'publish-stale'
          : 'publish-failed';
      const count = result.ok ? `&n=${result.value.changedKeys.length}` : '';

      return reply.code(303).header('location', `/?done=${done}${count}`).send();
    },
  );
}

/**
 * The notice a request's query asks for, if the console knows how to say it.
 *
 * `done` names an outcome and `n` counts it; both come off the URL, so both are whatever someone
 * typed. An unrecognised code and a nonsense count each render nothing rather than something.
 */
function noticeQuery(query: { done?: string; n?: string } | undefined): { notice?: PageNotice } {
  const notice = noticeFor(query?.done, query?.n === undefined ? {} : { n: Number(query.n) });
  return notice ? { notice } : {};
}

/**
 * The key rows of the add-product form, as posted.
 *
 * Fields arrive as `key.0.name`, `key.0.type` and so on, because a form cannot post an array of
 * objects. Rows are collected by index and rows with no name are dropped: the form always offers
 * one blank row, and a product with no keys is allowed.
 */
function keyBodies(body: Record<string, string | string[]>): Array<Record<string, string>> {
  const rows = new Map<number, Record<string, string>>();
  for (const [field, value] of Object.entries(body)) {
    const match = /^key\.(\d+)\.(\w+)$/.exec(field);
    if (!match) continue;
    const index = Number(match[1]);
    const row = rows.get(index) ?? {};
    row[String(match[2])] = Array.isArray(value) ? String(value[0]) : String(value);
    rows.set(index, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row)
    .filter((row) => (row.name ?? '').trim().length > 0);
}

/** Those rows as drafts the builder can check. Everything arrives as text and is parsed here. */
function keyDrafts(body: Record<string, string | string[]>): KeyDraft[] {
  return keyBodies(body).map((row) => {
    const type = (row.type ?? 'string') as KeyDraft['type'];
    const secret = row.secret === '1';
    const values = (row.values ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    // A bool is ticked, not typed. An unticked checkbox posts NOTHING — it is absent from the
    // body rather than present and false — which is exactly what "no default" means here.
    if (type === 'bool') {
      return {
        name: (row.name ?? '').trim(),
        type,
        secret: false,
        values: [],
        description: row.description ?? '',
        default: row.defaultBool === 'true' ? true : null,
      };
    }

    const raw = (row.default ?? '').trim();
    return {
      name: (row.name ?? '').trim(),
      type,
      secret,
      values,
      description: row.description ?? '',
      ...(row.min ? { min: Number(row.min) } : {}),
      ...(row.max ? { max: Number(row.max) } : {}),
      // Blank means no default, which is not the same as the empty string: a key declared with
      // "" would be created holding an empty value rather than nothing.
      default: raw.length === 0 ? null : parseDefault(type, raw),
    };
  });
}

/** A typed default from what was typed. Left as text where it does not parse, so the builder
 *  refuses it with a message about the value rather than silently coercing it. */
function parseDefault(type: KeyDraft['type'], raw: string): unknown {
  if (type === 'int') return Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (type === 'bool') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (type === 'string[]') return raw.split(',').map((entry) => entry.trim());
  return raw;
}

/** What every new environment file starts with: the declared defaults, and never a secret. */
function defaultsOf(keys: readonly KeyDraft[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.secret) continue;
    if (key.default === null || key.default === undefined) continue;
    defaults[key.name.trim()] = key.default;
  }
  return defaults;
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
