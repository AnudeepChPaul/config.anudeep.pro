import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GitRepository } from '../git/repository.js';
import type { KeyDefinition, SchemaSet } from '../schema/validator.js';
import type { ConfigLoader } from '../store/loader.js';
import type { ConfigWriteService } from '../store/write-service.js';
import { type KeyRow, renderIndex, renderNamespace } from '../views/pages.js';

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
}

interface NamespaceParams {
  service: string;
  environment: string;
}

/** Form field prefix. Everything else in the body is metadata, not configuration. */
const KEY_PREFIX = 'key.';

export function registerUiRoutes(app: FastifyInstance, options: UiRouteOptions): void {
  const { repository, loader, schemas, writeService } = options;

  const readNamespace = async (namespace: string) => {
    const sources = await repository.readSources();
    if (!sources.sources.has(namespace)) return null;
    const tree = await loader.resolve(sources);
    return { commit: sources.commit, config: tree.namespaces.get(namespace) ?? {} };
  };

  app.get('/', async (_request, reply) => {
    const sources = await repository.readSources();
    const unpushed = await repository.unpushedCommits();
    return reply.type('text/html; charset=utf-8').send(
      String(
        renderIndex({
          namespaces: [...sources.sources.keys()].sort(),
          commit: sources.commit,
          unpushed,
        }),
      ),
    );
  });

  app.get(
    '/ns/:service/:environment',
    async (request: FastifyRequest<{ Params: NamespaceParams }>, reply) => {
      const namespace = `${request.params.service}/${request.params.environment}`;
      const loaded = await readNamespace(namespace);
      if (!loaded) return reply.code(404).type('text/html; charset=utf-8').send('Not found');

      return reply.type('text/html; charset=utf-8').send(
        String(
          renderNamespace({
            namespace,
            commit: loaded.commit,
            rows: buildRows(schemas(), request.params.service, loaded.config),
          }),
        ),
      );
    },
  );

  app.post(
    '/ns/:service/:environment',
    async (
      request: FastifyRequest<{ Params: NamespaceParams; Body: Record<string, string> }>,
      reply,
    ) => {
      const { service, environment } = request.params;
      const namespace = `${service}/${environment}`;
      const body = request.body ?? {};
      const loaded = await readNamespace(namespace);
      if (!loaded) return reply.code(404).type('text/html; charset=utf-8').send('Not found');

      const schemaSet = schemas();
      const submitted = collectSubmitted(body);
      const changes = coerceChanges(schemaSet, service, submitted);

      const reRender = (status: number, formError: string, errors: Record<string, string> = {}) =>
        reply
          .code(status)
          .type('text/html; charset=utf-8')
          .send(
            String(
              renderNamespace({
                namespace,
                commit: loaded.commit,
                // Submitted values, not stored ones: retyping a form during an incident is how
                // the wrong value gets entered the second time.
                rows: buildRows(
                  schemaSet,
                  service,
                  { ...loaded.config, ...changes },
                  errors,
                  submitted,
                ),
                message: body.message ?? '',
                formError,
              }),
            ),
          );

      const message = (body.message ?? '').trim();
      if (!message) {
        // The message becomes the commit subject, which is the audit trail's only prose.
        return reRender(422, 'An audit message is required — it becomes the commit subject.');
      }

      const result = await writeService.save(
        {
          service,
          environment,
          baseCommit: body.baseCommit ?? '',
          changes,
          message,
        },
        { email: 'unauthenticated@localhost', id: 'anonymous' },
        { id: request.id, sourceIp: request.ip },
      );

      if (result.ok) return reply.code(303).header('location', `/ns/${namespace}`).send();

      if (result.error.code === 'conflict') {
        return reply
          .code(409)
          .type('text/html; charset=utf-8')
          .send(
            String(
              renderNamespace({
                namespace,
                commit: result.error.currentCommit ?? loaded.commit,
                rows: buildRows(schemaSet, service, loaded.config),
                message,
                formError:
                  'Someone else changed this configuration while this page was open. Reload and reapply your change.',
              }),
            ),
          );
      }

      const perKey = Object.fromEntries(
        (result.error.errors ?? []).map((error) => [error.key, error.message]),
      );
      return reRender(422, result.error.detail, perKey);
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
