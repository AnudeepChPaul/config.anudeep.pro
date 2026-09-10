import { isDeepStrictEqual } from 'node:util';
import type { Actor } from '@config/src/git/commit-trailers.js';
import { err, ok, type Result } from '@config/src/identity/types.js';
import { SchemaSet, type ValidationError } from '@config/src/schema/validator.js';
import { type DBEngine, etagFor, type MutationRequest } from '@config/src/store/data-layer.js';
import { EnvironmentOrder } from '@config/src/store/environment-order.js';
import type { ConfigLoader } from '@config/src/store/loader.js';
import { bumpedVersion, configOnly, isMetadataKey } from '@config/src/store/metadata.js';
import type { SopsEncryptor } from '@config/src/store/sops-encryptor.js';
import { parse, stringify } from 'yaml';

export interface ProductWriteError {
  readonly code: 'conflict' | 'invalid' | 'secret_not_encrypted' | 'failed' | 'would_orphan';
  readonly detail: string;
  readonly errors?: readonly ValidationError[];
  readonly currentCommit?: string;
}
export interface ProductWriteResult {
  readonly commit: string;
  readonly changedKeys: readonly string[];
}
export interface ProductWriteOptions {
  readonly db: DBEngine;
  readonly loader: ConfigLoader;
  readonly encryptor: SopsEncryptor;
  readonly onCommitted?: () => Promise<void> | void;
}
type Outcome = Result<ProductWriteResult, ProductWriteError>;
type SchemaDocument = {
  version: number;
  services: Record<string, { keys: Record<string, unknown>; retiring?: boolean }>;
};
type RegistryDocument = {
  version: number;
  services: { name: string; uid: number; namespaces: string[] }[];
};
class Refusal extends Error {
  constructor(readonly failure: ProductWriteError) {
    super(failure.detail);
  }
}
const refuse = (detail: string, code: ProductWriteError['code'] = 'invalid'): never => {
  throw new Refusal({ code, detail });
};
const identifier = (value: string) => /^[a-z][a-z0-9-]*$/.test(value);
export const productBase = (files: ReadonlyMap<string, string>, service: string): string =>
  etagFor(
    JSON.stringify(
      [...files]
        .filter(
          ([path]) =>
            ['schema.yaml', 'services.yaml', 'environments.yaml'].includes(path) ||
            path.startsWith(`config/${service}/`),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

/** One coherent read set and one atomic commit per logical product operation. */
export class ProductWriteOperations {
  constructor(private readonly options: ProductWriteOptions) {}

  createProduct(
    request: {
      service: string;
      uid: number;
      environments: readonly string[];
      schema: string;
      defaults: Readonly<Record<string, unknown>>;
    },
    actor: Actor,
  ): Promise<Outcome> {
    return this.run(request.service, actor, async (session) => {
      if (['new', 'retiring'].includes(request.service)) refuse('product name is reserved');
      if (!Number.isSafeInteger(request.uid) || request.uid < 0)
        refuse('uid must be a non-negative integer');
      // Naming the holder, not merely reporting a clash: a uid is claimed in one file the
      // operator may not have open, and "must be unique" leaves them to go and find which
      // product already has it.
      const byName = session.registry.services.find((entry) => entry.name === request.service);
      if (byName) refuse(`${request.service} is already declared`);
      const byUid = session.registry.services.find((entry) => entry.uid === request.uid);
      if (byUid) refuse(`uid ${request.uid} already belongs to ${byUid.name}`);
      if (session.schemas.has(request.service) || session.environments().length)
        refuse('product data already exists');
      if (
        !request.environments.length ||
        new Set(request.environments).size !== request.environments.length ||
        request.environments.some((env) => !identifier(env) || !session.order.all().includes(env))
      )
        refuse('choose distinct declared environments');
      const productSchema = SchemaSet.fromFiles({ [request.service]: request.schema });
      const validation = productSchema.validate(request.service, request.defaults);
      if (!validation.ok)
        throw new Refusal({
          code: 'invalid',
          detail: 'invalid defaults',
          errors: validation.error,
        });
      for (const key of Object.keys(request.defaults))
        if (isMetadataKey(key) || productSchema.isSecret(request.service, key))
          refuse('defaults cannot contain secrets or metadata');
      const definition = parse(request.schema);
      delete definition.version;
      session.schema.services[request.service] = definition;
      const candidate = SchemaSet.fromDocument(stringify(session.schema));
      session.put('schema.yaml', stringify(session.schema), [request.service]);
      for (const env of request.environments)
        session.put(
          `config/${request.service}/${env}.yaml`,
          await session.encode(env, { ...request.defaults, version: 1 }, candidate),
          Object.keys(request.defaults),
        );
      session.registry.services.push({
        name: request.service,
        uid: request.uid,
        namespaces: request.environments.map((env) => `${request.service}/${env}`),
      });
      session.put('services.yaml', stringify(session.registry), [request.service]);
    });
  }

  private async run(
    service: string,
    actor: Actor,
    action: (session: ProductMutation) => Promise<void>,
  ): Promise<Outcome> {
    if (!identifier(service)) return err({ code: 'invalid', detail: 'invalid product name' });
    try {
      const snapshot = await this.options.db.snapshot();
      const session = new ProductMutation(service, actor, snapshot.files, this.options);
      await action(session);
      const result = await session.commit();
      if (result.ok) await this.options.onCommitted?.();
      return result;
    } catch (error) {
      if (error instanceof Refusal) return err(error.failure);
      // Dependency errors can include plaintext. Never return them to the console or audit log.
      return err({
        code: 'failed',
        detail: `could not update ${service}; no successful write was acknowledged`,
      });
    }
  }

  writeValues(
    request: {
      service: string;
      environment: string;
      changes: Readonly<Record<string, unknown>>;
      expectedEtag?: string | null;
    },
    actor: Actor,
  ): Promise<Outcome> {
    return this.run(request.service, actor, async (session) => {
      session.requireProduct();
      await session.values(request.environment, request.changes, request.expectedEtag);
    });
  }

  setRetiring(service: string, retiring: boolean, actor: Actor): Promise<Outcome> {
    return this.run(service, actor, async (session) => {
      session.requireProduct();
      const definition = session.schema.services[service]!;
      if (retiring) definition.retiring = true;
      else delete definition.retiring;
      session.put('schema.yaml', stringify(session.schema), ['retiring']);
    });
  }

  promote(
    request: { service: string; from: string; to: string; keys: readonly string[] },
    actor: Actor,
  ): Promise<Outcome> {
    return this.run(request.service, actor, async (session) => {
      session.requireProduct();
      if (session.order.next(request.from) !== request.to)
        refuse('promotion target must be the next declared environment');
      const keys = session.select(request.keys);
      for (const key of keys)
        if (session.schemas.isSecret(request.service, key))
          refuse(`cannot promote a secret (${key}) — set it directly in ${request.to}`);
      const source = await session.document(request.from);
      const changes: Record<string, unknown> = {};
      for (const key of keys) {
        if (!Object.hasOwn(source, key)) refuse(`${key} is not set in ${request.from}`);
        changes[key] = source[key];
      }
      await session.values(request.to, changes);
    });
  }

  deleteKeys(
    service: string,
    selected: readonly string[],
    actor: Actor,
    expectedBase?: string,
  ): Promise<Outcome> {
    return this.run(service, actor, async (session) => {
      if (expectedBase !== undefined && expectedBase !== productBase(session.files, service))
        refuse('Product changed; review the deletion scope again.', 'conflict');
      session.requireProduct();
      const keys = session.select(selected);
      for (const key of keys) delete session.schema.services[service]!.keys[key];
      const candidate = SchemaSet.fromDocument(stringify(session.schema));
      for (const [path] of session.environments()) {
        const environment = path.slice(`config/${service}/`.length, -5);
        const current = await session.document(environment);
        const next = configOnly(current);
        for (const key of keys) delete next[key];
        const validation = candidate.validate(service, next);
        if (!validation.ok)
          refuse(`cannot remove keys: ${path} would remain invalid`, 'would_orphan');
        if (!isDeepStrictEqual(configOnly(current), next)) {
          next.version = bumpedVersion(current);
          session.put(path, await session.encode(environment, next, candidate), keys);
        }
      }
      session.put('schema.yaml', stringify(session.schema), keys);
    });
  }

  archiveProduct(service: string, actor: Actor, expectedBase?: string): Promise<Outcome> {
    return this.run(service, actor, async (session) => {
      if (expectedBase !== undefined && expectedBase !== productBase(session.files, service))
        refuse('Product changed; review the archive again.', 'conflict');
      const identity = session.requireProduct();
      if (!session.schemas.isRetiring(service))
        refuse('mark the product retiring before archiving');
      const archivePath = `archived/${service}.yaml`;
      if (session.files.has(archivePath)) refuse('an archive already exists for this product');
      const environments = Object.fromEntries(
        session
          .environments()
          .map(([path, source]) => [path.slice(`config/${service}/`.length, -5), source]),
      );
      const archive = stringify({
        version: 1,
        archived: { at: new Date().toISOString(), by: actor.email },
        service: identity,
        schema: stringify({ version: 1, ...session.schema.services[service] }),
        environments,
      });
      session.registry.services = session.registry.services.filter(
        (entry) => entry.name !== service,
      );
      session.put('services.yaml', stringify(session.registry), [service]);
      session.put(archivePath, archive, [service]);
      for (const [path] of session.environments()) session.put(path, null, [service]);
      delete session.schema.services[service];
      session.put('schema.yaml', stringify(session.schema), [service]);
    });
  }
}

/** Testable document, encryption, validation and compare-and-swap boundary for one operation. */
class ProductMutation {
  readonly schema: SchemaDocument;
  readonly schemas: SchemaSet;
  readonly registry: RegistryDocument;
  readonly order: EnvironmentOrder;
  private readonly writes: MutationRequest[] = [];
  private readonly reads = new Set(['schema.yaml', 'services.yaml', 'environments.yaml']);
  constructor(
    readonly service: string,
    private readonly actor: Actor,
    readonly files: ReadonlyMap<string, string>,
    private readonly options: ProductWriteOptions,
  ) {
    this.schema = parse(files.get('schema.yaml') ?? 'version: 1\nservices: {}\n');
    this.schemas = SchemaSet.fromDocument(stringify(this.schema));
    this.registry = parse(files.get('services.yaml') ?? 'version: 1\nservices: []\n');
    this.order = EnvironmentOrder.fromYaml(files.get('environments.yaml') ?? '');
  }
  requireProduct() {
    const identity = this.registry.services.find((entry) => entry.name === this.service);
    if (!identity || !this.schemas.has(this.service)) return refuse('unknown product');
    return identity;
  }
  select(keys: readonly string[]): string[] {
    const selected = [...new Set(keys)];
    if (!selected.length) refuse('select at least one key');
    for (const key of selected)
      if (!this.schemas.definitionsFor(this.service).has(key)) refuse(`unknown key: ${key}`);
    return selected;
  }
  environments() {
    return [...this.files].filter(
      ([path]) => path.startsWith(`config/${this.service}/`) && path.endsWith('.yaml'),
    );
  }
  private etag(path: string) {
    const source = this.files.get(path);
    return source === undefined ? null : etagFor(source);
  }
  async document(environment: string): Promise<Record<string, unknown>> {
    if (!identifier(environment)) return refuse('invalid environment');
    const path = `config/${this.service}/${environment}.yaml`;
    this.reads.add(path);
    const source = this.files.get(path);
    return source === undefined
      ? {}
      : { ...(await this.options.loader.resolveOne(`${this.service}/${environment}`, source)) };
  }
  async values(
    environment: string,
    changes: Readonly<Record<string, unknown>>,
    expectedEtag?: string | null,
  ) {
    if (!this.order.all().includes(environment)) refuse('environment is not declared');
    const path = `config/${this.service}/${environment}.yaml`;
    if (expectedEtag !== undefined && expectedEtag !== this.etag(path))
      refuse('file changed; review and reapply your edit', 'conflict');
    const current = await this.document(environment);
    const next = configOnly(current);
    for (const [key, value] of Object.entries(changes)) {
      if (isMetadataKey(key) || value === undefined)
        refuse('use product-wide Delete to remove keys; metadata cannot be edited');
      next[key] = value;
    }
    const validation = this.schemas.validate(this.service, next);
    if (!validation.ok)
      throw new Refusal({
        code: 'invalid',
        detail: 'configuration is invalid',
        errors: validation.error,
      });
    if (this.files.has(path) && isDeepStrictEqual(configOnly(current), next)) return;
    next.version = bumpedVersion(current);
    this.put(path, await this.encode(environment, next, this.schemas), Object.keys(changes));
  }
  async encode(environment: string, value: Record<string, unknown>, schemas: SchemaSet) {
    if (!Number.isSafeInteger(value.version)) refuse('document version exhausted');
    // Sorted, with the document's own fields last. Git is the audit medium, so a file ordered by
    // whenever each key happened to be set would show unrelated keys moving on every back-up,
    // hiding the one that actually changed.
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(configOnly(value)).sort()) ordered[key] = value[key];
    for (const [key, held] of Object.entries(value))
      if (!Object.hasOwn(ordered, key)) ordered[key] = held;
    const source = await this.options.encryptor.encrypt(
      `${this.service}/${environment}`,
      stringify(ordered),
    );
    const encrypted = parse(source);
    if (!encrypted || typeof encrypted !== 'object' || Array.isArray(encrypted))
      refuse('encryptor returned an invalid document');
    for (const key of Object.keys(configOnly(value)))
      if (
        schemas.isSecret(this.service, key) &&
        !(typeof encrypted[key] === 'string' && encrypted[key].startsWith('ENC[AES256_GCM,'))
      )
        refuse(`secret values were not encrypted: ${key}`, 'secret_not_encrypted');
    return source;
  }
  put(path: string, content: string | null, keys: readonly string[]) {
    this.writes.push({
      path,
      content,
      expectedEtag: this.etag(path),
      actor: this.actor.via ? `${this.actor.email} (${this.actor.via})` : this.actor.email,
      keys,
    });
  }
  async commit(): Promise<Outcome> {
    const result = await this.options.db.writeMany(
      this.writes,
      [...this.reads].map((path) => ({ path, expectedEtag: this.etag(path) })),
      [
        {
          path: `config/${this.service}`,
          files: this.environments().map(([path]) => path.slice(`config/${this.service}/`.length)),
        },
      ],
    );
    if (result.kind === 'conflict')
      return err({
        code: 'conflict',
        detail: `${result.path} changed; review and reapply your edit`,
        currentCommit: result.revision,
      });
    if (result.kind === 'invalid')
      return err({ code: 'invalid', detail: 'invalid files', errors: result.errors });
    return ok({
      commit: result.revision,
      changedKeys: [...new Set(this.writes.flatMap((write) => write.keys ?? []))],
    });
  }
}
