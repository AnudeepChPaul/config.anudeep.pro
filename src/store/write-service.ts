import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type Actor,
  CommitTrailerBuilder,
  type KeyChange,
  type RequestContext,
} from '../git/commit-trailers.js';
import type { GitRepository } from '../git/repository.js';
import { WriteLock } from '../git/write-lock.js';
import { err, ok, type Result } from '../identity/types.js';
import { SchemaSet, type ValidationError } from '../schema/validator.js';
import type { Draft, DraftChange, DraftStore } from './draft-store.js';
import type { ConfigLoader } from './loader.js';
import { bumpedVersion, VERSION_KEY, versionOf } from './metadata.js';
import type { SopsEncryptor } from './sops-encryptor.js';
import type { RawConfig, Sha } from './types.js';

/**
 * The write path: validate, check for a stale base, encrypt, commit.
 *
 * Everything happens under one lock, because git has no concurrency control and the stale check
 * alone cannot catch two writers who read the same HEAD before either wrote.
 */

export interface SaveRequest {
  readonly service: string;
  readonly environment: string;
  /** The commit the editor loaded. A save based on anything but HEAD is refused. */
  readonly baseCommit: Sha;
  /** Key to new value. `undefined` deletes the override. */
  readonly changes: Readonly<Record<string, unknown>>;
  readonly message: string;
}

export interface SaveResult {
  readonly commit: Sha;
  readonly changedKeys: readonly string[];
  /**
   * Whether the commit reached the remote.
   *
   * False is not a failure. The commit is durable locally and already being served; the push is
   * how it becomes off-host backup, and the background retry will catch up. The UI shows this
   * as unpublished rather than as an error.
   */
  readonly published: boolean;
}

export interface SaveError {
  readonly code: 'conflict' | 'invalid' | 'secret_not_encrypted' | 'failed' | 'nothing_staged';
  readonly detail: string;
  readonly errors?: readonly ValidationError[];
  /** On a conflict, the commit the editor should reload from. */
  readonly currentCommit?: Sha;
}

export interface ConfigWriteServiceOptions {
  readonly repository: GitRepository;
  readonly loader: ConfigLoader;
  readonly encryptor: SopsEncryptor;
  /** Re-read per save, so a schema change takes effect without a restart. */
  readonly schemas: () => SchemaSet;
  readonly lock?: WriteLock;
  /** Where unpublished edits live. Absent keeps the old commit-on-save behaviour. */
  readonly drafts?: DraftStore;
}

/**
 * A namespace to publish.
 *
 * There is no key narrowing: a draft publishes whole. Shipping some of a draft's keys and
 * re-staging the rest gave a button that counted drafts and an outcome that shipped keys — two
 * different things behind one number. To hold a change back now, undo the change.
 */
export interface PublishSelection {
  readonly namespace: string;
}

export interface PromoteRequest {
  readonly service: string;
  readonly from: string;
  readonly to: string;
  readonly keys: readonly string[];
}

/** A product to declare: its identity, where it lives, and what its keys are. */
/**
 * The environment name a retirement draft is filed under.
 *
 * Not a real environment and never declared in environments.yaml, which is exactly why it works:
 * everything that counts drafts per declared environment ignores it, so a retirement never
 * appears as an environment update waiting to be published.
 */
export const RETIRING_ENVIRONMENT = 'retiring';

export interface ProductRequest {
  readonly service: string;
  readonly uid: number;
  readonly environments: readonly string[];
  /** The schema file, already built and validated by `buildSchema`. */
  readonly schema: string;
  /** What each environment file starts with. Secrets are absent, never null. */
  readonly defaults: Readonly<Record<string, unknown>>;
}

export interface StageRequest {
  readonly service: string;
  readonly environment: string;
  /** Key to new value. `undefined` removes the override. */
  readonly changes: Readonly<Record<string, unknown>>;
  /**
   * Keys the operator ticked. A tick on a key whose value has not moved is how you say "send
   * this one along" — to a publish, and from there to the next environment — so it is written
   * into the draft too, or the intent is lost the moment the page is left.
   */
  readonly selected?: readonly string[];
}

/** Recognises a SOPS-encrypted value, to confirm the secrets really were encrypted. */
const ENCRYPTED = /^ENC\[AES256_GCM,/;

/**
 * One draft's line in a commit body: where it was, the day the edit was made, and what it
 * touched.
 *
 * The date is the SAVE's, not the publish's — the line describes an edit, and stamping every
 * line with the publish time would make them all claim the same moment, which is the one thing
 * the body is there to distinguish.
 *
 * Key names appear, a secret's included: a name is not a value, and the commit trailers already
 * carry key names.
 */
function draftLine(namespace: string, save: { keys: readonly string[]; at: number }): string {
  const [service = '', environment = ''] = namespace.split('/');
  const day = new Date(save.at).toISOString().slice(0, 10);
  return `[${service}-${environment}] ${day} ${[...save.keys].sort().join(' ')}`.trimEnd();
}

export class ConfigWriteService {
  private readonly lock: WriteLock;
  private readonly trailers = new CommitTrailerBuilder();

  constructor(private readonly options: ConfigWriteServiceOptions) {
    this.lock = options.lock ?? new WriteLock();
  }

  async save(
    request: SaveRequest,
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<SaveResult, SaveError>> {
    return this.lock.withLock(() => this.saveLocked(request, actor, context));
  }

  private async saveLocked(
    request: SaveRequest,
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<SaveResult, SaveError>> {
    const { repository } = this.options;
    const namespace = `${request.service}/${request.environment}`;

    const head = await repository.headCommit();
    if (request.baseCommit !== head) {
      // The editor is looking at values someone else has already replaced. Applying this would
      // silently discard their change, and the history would show two clean commits.
      return err({
        code: 'conflict',
        detail: 'the configuration changed since this page was loaded',
        currentCommit: head,
      });
    }

    const sources = await repository.readSources();
    const tree = await this.options.loader.resolve(sources);
    const current = tree.namespaces.get(namespace) ?? {};

    const { next, changes } = applyChanges(current, request.changes);
    if (changes.length === 0) {
      return ok({ commit: head, changedKeys: [], published: true });
    }

    const validation = this.options.schemas().validate(request.service, next);
    if (!validation.ok) {
      return err({
        code: 'invalid',
        detail: 'the change does not match the schema',
        errors: validation.error,
      });
    }

    // Keys are sorted so a diff shows the key that changed rather than every key moving.
    const plaintext = stringifyYaml(sortKeys(next));
    const encrypted = await this.options.encryptor.encrypt(namespace, plaintext);

    const unprotected = this.secretsLeftInPlaintext(request.service, next, encrypted);
    if (unprotected.length > 0) {
      // The schema says these are secret; `.sops.yaml` did not encrypt them. Neither file is
      // obviously wrong on its own, and committing would publish the secret in the clear.
      return err({
        code: 'secret_not_encrypted',
        detail: `.sops.yaml does not encrypt: ${unprotected.join(', ')}`,
      });
    }

    const message = this.trailers.build(
      actor,
      {
        message: request.message,
        service: request.service,
        environment: request.environment,
        keys: changes,
      },
      context,
    );

    const commit = await repository.writeAndCommit(
      { [`config/${namespace}.yaml`]: encrypted },
      message,
    );

    // After the commit, deliberately. A push failure must not undo a save that is already
    // durable and already being served — during a GitHub outage an operator still has to be
    // able to close registration.
    const push = await repository.push();

    return ok({ commit, changedKeys: changes.map((c) => c.key), published: push.pushed });
  }

  /**
   * Validates and encrypts a change, and holds it as a draft. Does not commit.
   *
   * The write path used to commit here, which made "saved" mean durable. Publishing per
   * environment or per product needs this middle state — but validation stays at this end of
   * it, so an operator learns a value is wrong when they type it rather than when they try to
   * ship three environments at once.
   */
  /**
   * The committed grant table, or an empty one where the registry has none yet.
   *
   * Read here rather than taken from the caller: the uid check has to be against what is
   * actually committed, and a form that posted its own copy of the table would be checking
   * against whatever it was rendered with.
   */
  private async readRegistry(): Promise<string> {
    try {
      return await this.options.repository.readFile('services.yaml');
    } catch {
      return 'version: 1\nservices: []\n';
    }
  }

  /**
   * Declares a product: a registry entry, a schema, and one file per environment, in one draft.
   *
   * One draft rather than three, because these files are only meaningful together. A registry
   * entry without its schema is a product the console refuses to open; a schema without its
   * entry is a file nothing reads; an environment file without either is unreachable. Publishing
   * them separately would leave the registry in one of those states for as long as it took
   * somebody to publish the second one -- and drafts are dropped and published by hand.
   *
   * The uid check happens here, against the committed registry, and not only in the form: a
   * duplicate uid makes ServiceRegistry throw at load, which takes the whole console down rather
   * than failing the request that caused it.
   */
  /**
   * Marks a product as retiring, or takes the mark off again.
   *
   * Touches the schema and nothing else. The values do not change, so the namespace document is
   * left exactly as it is: rewriting it would bump the revision counter for a change nobody
   * made, and that counter is what a consumer uses to decide whether it is up to date. A false
   * bump says "there is something new here" about a file that is byte-identical.
   *
   * Staged like every other change, so it is reviewable, droppable, and published as a commit
   * with the usual trailers.
   */
  /**
   * Takes a retiring product out of the live tree and files it under `archived/`.
   *
   * The one write here that does not pass through a draft: it commits immediately. That is the
   * operator's decision, and it is why the act is reachable only from the retiring list — by the
   * time it happens the product has been visibly retiring, and its consumers have been told.
   *
   * Refused unless the product is actually retiring. Archiving revokes a grant and stops a
   * namespace being served, and doing that to a product nobody has marked would skip the entire
   * interval the two steps exist to create.
   */
  async archiveProduct(
    service: string,
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<{ commit: Sha; path: string }, SaveError>> {
    if (!this.options.schemas().isRetiring(service)) {
      return err({
        code: 'failed',
        detail: `${service} is not retiring; mark it retiring before archiving it`,
      });
    }

    return this.lock.withLock(async () => {
      const repository = this.options.repository;
      const sources = await repository.readSources();

      const registrySource = await this.readRegistry();
      const registry = parseYaml(registrySource) as {
        version?: number;
        services?: Array<{ name: string; uid: number; namespaces: string[] }>;
      } | null;
      const entry = (registry?.services ?? []).find((candidate) => candidate.name === service);
      if (!entry) return err({ code: 'failed', detail: `${service} is not in the registry` });

      const schemaPath = `schema/${service}.yaml`;
      const schema = await repository.readFile(schemaPath).catch(() => '');

      // Each environment file is kept VERBATIM. Every one carries its own SOPS envelope — its own
      // encrypted data key and its own message authentication code over that file's structure —
      // so merging them into one document would destroy both, and nothing here decrypts anything
      // in order to archive it.
      const environments: Record<string, string> = {};
      const removals: Record<string, string | null> = {};
      for (const [namespace, contents] of sources.sources) {
        const [owner, environment] = namespace.split('/');
        if (owner !== service || !environment) continue;
        environments[environment] = contents;
        removals[`config/${namespace}.yaml`] = null;
      }

      const archive = {
        version: 1,
        archived: {
          at: new Date().toISOString(),
          by: actor.email,
          // What the tree looked like when the product left it, so a restore knows which history
          // to read without going hunting for the commit that did this.
          commit: sources.commit,
        },
        service: { name: entry.name, uid: entry.uid, namespaces: entry.namespaces },
        schema,
        environments,
      };

      const remaining = (registry?.services ?? []).filter(
        (candidate) => candidate.name !== service,
      );
      const path = `archived/${service}.yaml`;

      const message = this.trailers.build(
        actor,
        {
          message: `Archive ${service}\n\nRemoved from the live tree and filed under ${path}. Its grant, its schema and every environment are in that file; nothing was decrypted to write it.`,
          service,
          environment: Object.keys(environments).join(', '),
          keys: [],
        },
        context,
      );

      const commit = await repository.writeAndCommit(
        {
          [path]: stringifyYaml(archive),
          'services.yaml': stringifyYaml({ version: registry?.version ?? 1, services: remaining }),
          [schemaPath]: null,
          ...removals,
        },
        message,
      );

      // Whatever was staged for this product describes files that no longer exist.
      await this.options.drafts?.remove(Object.keys(environments).map((e) => `${service}/${e}`));
      await repository.push();

      return ok({ commit, path });
    });
  }

  async stageSchemaFlag(
    request: { service: string; retiring: boolean },
    actor: Actor,
  ): Promise<Result<Draft, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    return this.lock.withLock(async () => {
      const path = `schema/${request.service}.yaml`;
      let source: string;
      try {
        source = await this.options.repository.readFile(path);
      } catch {
        return err({ code: 'failed', detail: `${request.service} has no schema to mark` });
      }

      const parsed = (parseYaml(source) ?? {}) as Record<string, unknown>;
      // Written when true and REMOVED when false, rather than left as `retiring: false`. A file
      // that says false and a file that says nothing mean the same thing, and keeping the key
      // would leave every cancelled retirement visible forever in the schema.
      const next: Record<string, unknown> = { ...parsed };
      if (request.retiring) next.retiring = true;
      else delete next.retiring;

      const sources = await this.options.repository.readSources();
      /**
       * Its own draft, under a reserved environment name.
       *
       * A retirement is not an environment update. Attaching it to a namespace's draft put a
       * value change and a retirement in one draft, so publishing the values would have shipped
       * a retirement nobody chose to publish — and the products screen, which counts drafts per
       * DECLARED environment, would have counted it as work waiting there.
       *
       * `retiring` is declared as an environment nowhere, which is what keeps it out of both.
       */
      const namespace = `${request.service}/${RETIRING_ENVIRONMENT}`;
      const anyEnvironment = [...sources.sources.keys()]
        .filter((entry) => entry.startsWith(`${request.service}/`))
        .sort()[0];
      if (!anyEnvironment) {
        return err({
          code: 'failed',
          detail: `${request.service} has no environment to stage against`,
        });
      }

      /**
       * Reverting a retirement nobody published has nothing to undo.
       *
       * The mark never left this console, so the honest answer is to drop the draft. Staging
       * "not retiring" on top of it would leave a draft that changes nothing against the
       * committed schema and still has to be published to make a change nobody made go away.
       */
      const committedSchema = stringifyYaml(parseYaml(source) ?? {});
      if (stringifyYaml(next) === committedSchema) {
        await drafts.remove([namespace]);
        return ok({
          kind: 'PRODUCT_RETIREMENT',
          namespace,
          document: '',
          changes: [],
          saves: [],
          actor: actor.email,
          updatedAt: Date.now(),
          basedOn: null,
          files: {},
        } satisfies Draft);
      }
      const existing = await drafts.get(namespace);
      // Never written: this draft changes no values. A draft has to carry a document, and the
      // emptiest honest one is what the service already serves.
      const document = existing?.document ?? (sources.sources.get(anyEnvironment) as string);
      const save = {
        keys: [request.retiring ? 'retiring' : 'retirement cancelled'],
        actor: actor.email,
        at: Date.now(),
        document,
      };

      const draft: Draft = {
        kind: 'PRODUCT_RETIREMENT',
        namespace,
        document,
        changes: existing?.changes ?? [],
        saves: [...(existing?.saves ?? []), save],
        actor: actor.email,
        updatedAt: Date.now(),
        // Nothing underneath it to go stale: this draft writes a schema, not a namespace file.
        basedOn: null,
        files: { ...(existing?.files ?? {}), [path]: stringifyYaml(next) },
      };

      await drafts.put(draft);
      return ok(draft);
    });
  }

  async stageProduct(request: ProductRequest, actor: Actor): Promise<Result<Draft, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    if (request.environments.length === 0) {
      return err({
        code: 'failed',
        detail: 'a product must be declared in at least one environment',
      });
    }

    return this.lock.withLock(async () => {
      const registrySource = await this.readRegistry();
      const registry = parseYaml(registrySource) as {
        version?: number;
        services?: Array<{ name: string; uid: number; namespaces: string[] }>;
      } | null;
      const services = registry?.services ?? [];

      const claimed = services.find((entry) => entry.uid === request.uid);
      if (claimed) {
        return err({
          code: 'failed',
          detail: `uid ${request.uid} is already claimed by '${claimed.name}'`,
        });
      }
      if (services.some((entry) => entry.name === request.service)) {
        return err({ code: 'failed', detail: `'${request.service}' is already declared` });
      }

      const namespaces = request.environments.map((env) => `${request.service}/${env}`);
      const next = {
        version: registry?.version ?? 1,
        services: [...services, { name: request.service, uid: request.uid, namespaces }],
      };

      // Every environment file, encrypted as it will be committed. The defaults come from the
      // schema and hold no secret: a secret is declared and set later, on the product page.
      const files: Record<string, string> = {
        'services.yaml': stringifyYaml(next),
        [`schema/${request.service}.yaml`]: request.schema,
      };
      const document: Record<string, unknown> = { ...request.defaults, [VERSION_KEY]: 1 };
      for (const namespace of namespaces.slice(1)) {
        files[`config/${namespace}.yaml`] = await this.options.encryptor.encrypt(
          namespace,
          stringifyYaml(sortKeys(document)),
        );
      }

      const primary = namespaces[0] as string;
      const draft: Draft = {
        kind: 'PRODUCT_CREATION',
        namespace: primary,
        document: await this.options.encryptor.encrypt(primary, stringifyYaml(sortKeys(document))),
        changes: Object.keys(request.defaults).map((key) => ({
          key,
          from: undefined,
          to: request.defaults[key],
          // Nothing here is secret: a secret is declared without a value and set later.
          secret: false,
        })),
        saves: [
          {
            keys: Object.keys(request.defaults),
            actor: actor.email,
            at: Date.now(),
            document: await this.options.encryptor.encrypt(
              primary,
              stringifyYaml(sortKeys(document)),
            ),
          },
        ],
        actor: actor.email,
        updatedAt: Date.now(),
        // Nothing was there before: this draft creates the namespace, and null says so rather
        // than leaving it unknowable.
        basedOn: null,
        files,
      };

      await drafts.put(draft);
      return ok(draft);
    });
  }

  async stage(request: StageRequest, actor: Actor): Promise<Result<Draft, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    return this.lock.withLock(async () => {
      const namespace = `${request.service}/${request.environment}`;
      const sources = await this.options.repository.readSources();
      const tree = await this.options.loader.resolve(sources);
      const committed = tree.namespaces.get(namespace) ?? {};

      // Built on any earlier draft for this namespace, so two edits to the same environment
      // accumulate rather than the second discarding the first.
      const existing = await drafts.get(namespace);
      const base = existing
        ? await this.options.loader.resolveOne(namespace, existing.document)
        : committed;

      const { next, changes } = applyChanges(base, request.changes);
      // Ticked, but not edited. Recorded as itself rather than as a value moving to itself, so
      // the change list says selected and not "optional → optional".
      const edited = new Set(changes.map((change) => change.key));
      // Not filtered by whether the key already has a value. A tick is a statement of intent —
      // "send this one along" — and it counts as a change on its own, which is what makes five
      // edits to a namespace five version bumps. Requiring the key to exist in the document
      // silently dropped every tick on a product created with keys that declare no defaults:
      // every one of those keys is absent from the file, so ticking any of them did nothing and
      // Save answered "nothing to save".
      const selectedOnly = (request.selected ?? []).filter((key) => !edited.has(key));

      // Nothing moved and nothing was ticked. Writing a draft anyway would put an empty pending
      // marker on the environment and offer a publish with no content behind it.
      if (changes.length === 0 && selectedOnly.length === 0) {
        // An existing draft with nothing in it is not a draft: it puts a pending marker on the
        // environment and offers a publish with no content behind it.
        if (existing && existing.changes.length > 0) return ok(existing);
        if (existing) await drafts.remove([namespace]);
        return err({ code: 'nothing_staged', detail: 'nothing changed' });
      }

      const validation = this.options.schemas().validate(request.service, next);
      if (!validation.ok) {
        return err({
          code: 'invalid',
          detail: 'the change does not match the schema',
          errors: validation.error,
        });
      }

      // A revision of the document, so the counter moves here and nowhere else. Publishing
      // writes down what a draft already decided; counting that as a second revision would make
      // the number mean nothing in particular.
      //
      // Numbered from the draft in hand, not from the committed file: five edits before a
      // publish are five revisions of the document, and numbering from what is committed would
      // collapse them into one.
      next[VERSION_KEY] = bumpedVersion(base);

      const plaintext = stringifyYaml(sortKeys(next));
      const document = await this.options.encryptor.encrypt(namespace, plaintext);

      const unprotected = this.secretsLeftInPlaintext(request.service, next, document);
      if (unprotected.length > 0) {
        return err({
          code: 'secret_not_encrypted',
          detail: `.sops.yaml does not encrypt: ${unprotected.join(', ')}`,
        });
      }

      // A secret's before and after are dropped here, not at render time. The console shows
      // this list on hover, and a value that never enters it cannot leak out of it.
      const schemas = this.options.schemas();
      const asDraftChange = (key: string, from: unknown, to: unknown): DraftChange =>
        schemas.isSecret(request.service, key)
          ? { key, from: undefined, to: undefined, secret: true }
          : { key, from, to, secret: false };

      const recorded: DraftChange[] = [
        ...(existing?.changes ?? []).map((c) => asDraftChange(c.key, c.from, c.to)),
        // Selected first, so an edit to the same key in this save replaces it: dedupeByKey
        // keeps the last entry, and an edit says more than a selection does.
        ...selectedOnly.map((key) => asDraftChange(key, base[key], base[key])),
        ...changes.map((c) => asDraftChange(c.key, c.oldValue, c.newValue)),
      ];

      const draft: Draft = {
        // An ordinary edit to an environment's values, which is what stage() is for. A product
        // being created and a product being retired each say so themselves.
        kind: 'ENV_UPDATES',
        namespace,
        document,
        changes: dedupeByKey(recorded),
        // One entry per press of Save. This is what the console counts — "Publish 2 drafts?" —
        // and what a publish turns into one generated line each. Nobody types a message, so a
        // save records only facts: what it touched, who made it, and when.
        saves: [
          ...(existing?.saves ?? []),
          {
            keys: [...new Set([...changes.map((change) => change.key), ...selectedOnly])],
            actor: actor.email,
            at: Date.now(),
            document,
          },
        ],
        actor: actor.email,
        updatedAt: Date.now(),
        // What the namespace looked like when this draft was built, so publishing can tell
        // whether the file moved underneath it.
        // null when there is no file: this draft creates the namespace. Recorded rather than
        // omitted, so publish can tell "there was nothing to base this on" apart from "an older
        // build did not say".
        basedOn: sources.sources.has(namespace)
          ? (existing?.basedOn ?? sources.sources.get(namespace) ?? null)
          : null,
      };
      await drafts.put(draft);
      return ok(draft);
    });
  }

  /**
   * Commits what was selected as ONE commit, and pushes.
   *
   * A selection may narrow a namespace to some of its staged keys: the console lets an operator
   * tick individual changes and ship only those. Whatever is left stays staged, rebased onto the
   * commit that just happened — carrying the old base forward would make the next publish either
   * conflict or quietly revert the key just published.
   *
   * Still all-or-nothing across the selection: a partial publish would commit half of what was
   * chosen and report success.
   */
  async publish(
    selections: readonly (string | PublishSelection)[],
    actor: Actor,
    context: RequestContext,
  ): Promise<Result<SaveResult, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    // A bare namespace means "everything staged there", which is now the only thing a selection
    // can mean: drafts publish whole.
    const chosenSelections: PublishSelection[] = selections.map((entry) =>
      typeof entry === 'string' ? { namespace: entry } : entry,
    );
    if (chosenSelections.length === 0) {
      return err({ code: 'nothing_staged', detail: 'nothing was selected' });
    }

    return this.lock.withLock(async () => {
      const sources = await this.options.repository.readSources();
      const tree = await this.options.loader.resolve(sources);
      const schemas = this.options.schemas();

      const files: Record<string, string> = {};
      const keyChanges: KeyChange[] = [];
      const summaryLines: string[] = [];
      let drafted = 0;

      for (const selection of chosenSelections) {
        const draft = await drafts.get(selection.namespace);
        if (!draft) {
          return err({
            code: 'nothing_staged',
            detail: `nothing is staged for ${selection.namespace}`,
          });
        }

        const current = sources.sources.get(selection.namespace);
        // Two ways the file can have moved underneath a draft: it changed, or it appeared. The
        // second was invisible while an absent base meant "not recorded" — so a draft that
        // created a namespace overwrote whatever another host had committed meanwhile.
        const changed = draft.basedOn != null && current !== undefined && draft.basedOn !== current;
        const appeared = draft.basedOn === null && current !== undefined;
        if (changed || appeared) {
          return err({
            code: 'conflict',
            detail: appeared
              ? `${selection.namespace} was created elsewhere since this edit was made`
              : `${selection.namespace} changed since this edit was made`,
            currentCommit: sources.commit,
          });
        }

        const chosen = draft.changes.map((change) => change.key);

        // A retirement carries files and no document worth writing: rewriting the namespace
        // would bump its revision for a change nobody made, and that counter is how a consumer
        // decides whether it is up to date.
        //
        // The draft says which it is. This was inferred twice — first from an empty change list,
        // then from the namespace — and the first inference caught a product whose keys declare
        // no defaults, skipping its first environment file.
        if (draft.kind === 'PRODUCT_RETIREMENT') {
          Object.assign(files, draft.files);
          summaryLines.push(...draft.saves.map((save) => draftLine(selection.namespace, save)));
          drafted += draft.saves.length;
          continue;
        }

        // The draft holds the whole document with secrets already encrypted, so it is decrypted
        // in memory to read the values this commit is about to carry.
        const stagedConfig = await this.options.loader.resolveOne(
          selection.namespace,
          draft.document,
        );
        const committed = tree.namespaces.get(selection.namespace) ?? {};
        const service = selection.namespace.split('/')[0] ?? '';

        const next: Record<string, unknown> = { ...committed };
        for (const key of chosen) {
          if (key in stagedConfig) next[key] = stagedConfig[key];
          else delete next[key];
          keyChanges.push({ key, oldValue: committed[key], newValue: stagedConfig[key] });
        }

        // Carried from the draft, not recomputed: this commit IS that revision of the document.
        // Clamped above what is committed, because a draft built before the file existed carries
        // a number that owes nothing to it — and a counter that goes backwards tells a consumer
        // it is up to date when it is not.
        next[VERSION_KEY] = Math.max(versionOf(stagedConfig), versionOf(committed) + 1);

        // A draft that DECLARES a service carries its schema, and the committed set cannot know
        // about it: the schema is the thing being added. Validating against the committed set
        // would refuse every product the console creates, on the grounds that it has no schema.
        const carried = draft.files?.[`schema/${service}.yaml`];
        const effective = carried
          ? SchemaSet.fromFiles({
              ...(await this.options.repository.readSchemas()),
              [service]: carried,
            })
          : schemas;

        const validation = effective.validate(service, next);
        if (!validation.ok) {
          return err({
            code: 'invalid',
            detail: 'the change does not match the schema',
            errors: validation.error,
          });
        }

        const document = await this.options.encryptor.encrypt(
          selection.namespace,
          stringifyYaml(sortKeys(next)),
        );
        const unprotected = this.secretsLeftInPlaintext(service, next, document);
        if (unprotected.length > 0) {
          return err({
            code: 'secret_not_encrypted',
            detail: `.sops.yaml does not encrypt: ${unprotected.join(', ')}`,
          });
        }

        files[`config/${selection.namespace}.yaml`] = document;
        // Whatever else this draft declares — a registry entry, a schema, the other environment
        // files of a product being created — lands in the same commit. Separately, the registry
        // would spend the time between two publishes in a state it should never be in.
        Object.assign(files, draft.files ?? {});
        // One line per draft, in the order the saves were made.
        summaryLines.push(...draft.saves.map((save) => draftLine(selection.namespace, save)));
        drafted += draft.saves.length;
      }

      // Generated, never typed. An operator has better things to do mid-incident than compose a
      // subject line, and a generated one cannot be left as "wip".
      const scope = [...new Set(chosenSelections.map((s) => s.namespace))].join(', ');
      const message = [
        `Publish ${drafted} draft${drafted === 1 ? '' : 's'} in ${scope}`,
        '',
        ...summaryLines,
      ].join('\n');

      const commitMessage = this.trailers.build(
        actor,
        {
          message,
          service: [...new Set(chosenSelections.map((s) => s.namespace.split('/')[0]))].join(', '),
          environment: [...new Set(chosenSelections.map((s) => s.namespace.split('/')[1]))].join(
            ', ',
          ),
          keys: keyChanges,
        },
        context,
      );

      const commit = await this.options.repository.writeAndCommit(files, commitMessage);
      await drafts.remove(chosenSelections.map((s) => s.namespace));

      const push = await this.options.repository.push();

      return ok({ commit, changedKeys: keyChanges.map((k) => k.key), published: push.pushed });
    });
  }

  /**
   * Drops one save from a draft, the way git drops a commit.
   *
   * The dropped save's effect goes; every other save replays onto the committed state in order,
   * each contributing the values its own snapshot holds. Where git would stop on a conflicting
   * replay, a later save's value simply wins — every delta here is "set this key to this value",
   * so there is nothing to resolve.
   *
   * Nothing is committed: a draft is not in the repository, so dropping one needs no revert.
   */
  async dropSave(
    namespace: string,
    index: number,
    actor: Actor,
  ): Promise<Result<Draft | null, SaveError>> {
    const drafts = this.options.drafts;
    if (!drafts) return err({ code: 'failed', detail: 'staging is not enabled' });

    return this.lock.withLock(async () => {
      const draft = await drafts.get(namespace);
      if (!draft)
        return err({ code: 'nothing_staged', detail: `nothing is staged for ${namespace}` });
      // Number.isInteger rather than a range check alone: NaN passes `< 0` and `>= length`, and
      // `filter((_, at) => at !== NaN)` then keeps every save — so the draft was rebuilt
      // identically, its version bumped, and the console reported a drop that never happened.
      if (!Number.isInteger(index) || index < 0 || index >= draft.saves.length) {
        return err({ code: 'nothing_staged', detail: `${namespace} has no draft ${index + 1}` });
      }

      const remaining = draft.saves.filter((_, at) => at !== index);
      // Every remaining save has to be replayable from its own state. Falling back to the draft
      // document restored the values being dropped; falling back to the committed one reverts
      // further than asked. Both are wrong answers offered as right ones, so this refuses.
      const unreplayable = remaining.filter((save) => !save.document);
      if (unreplayable.length > 0) {
        return err({
          code: 'failed',
          detail: `${namespace} holds a draft with no snapshot to replay; drop the whole draft instead`,
        });
      }
      if (remaining.length === 0) {
        // A draft with no saves in it is not a draft: it would sit on the environment as a
        // pending marker with nothing behind it.
        await drafts.remove([namespace]);
        return ok(null);
      }

      const sources = await this.options.repository.readSources();
      const tree = await this.options.loader.resolve(sources);
      const committed = tree.namespaces.get(namespace) ?? {};
      const service = namespace.split('/')[0] ?? '';
      const schemas = this.options.schemas();

      const next: Record<string, unknown> = { ...committed };
      const changes: DraftChange[] = [];
      for (const save of remaining) {
        // Each save's own snapshot, so a replayed key carries the value it had at that save and
        // not the value the draft ended up with.
        // Its own snapshot. There is no fallback to the draft document: that holds the values
        // being dropped, so falling back to it restored them.
        const at = await this.options.loader.resolveOne(namespace, save.document ?? '');
        for (const key of save.keys) {
          if (key in at) next[key] = at[key];
          else delete next[key];
        }
      }

      for (const key of new Set(remaining.flatMap((save) => [...save.keys]))) {
        changes.push(
          schemas.isSecret(service, key)
            ? { key, from: undefined, to: undefined, secret: true }
            : { key, from: committed[key], to: next[key], secret: false },
        );
      }

      // A revision of the document like any other write to it.
      next[VERSION_KEY] = bumpedVersion(
        await this.options.loader.resolveOne(namespace, draft.document),
      );

      const document = await this.options.encryptor.encrypt(
        namespace,
        stringifyYaml(sortKeys(next)),
      );

      const rebuilt: Draft = {
        ...draft,
        document,
        changes: dedupeByKey(changes),
        saves: remaining,
        actor: actor.email,
        updatedAt: Date.now(),
      };
      await drafts.put(rebuilt);
      return ok(rebuilt);
    });
  }

  /**
   * Stages a published value from one environment into another.
   *
   * Only what the operator just shipped moves, and never a secret: SOPS gives each file its own
   * data key, so the source's ciphertext would not decrypt in the target. Refusing beats
   * skipping it silently, which would leave them believing it moved.
   */
  async promote(request: PromoteRequest, actor: Actor): Promise<Result<Draft, SaveError>> {
    const from = `${request.service}/${request.from}`;
    const schemas = this.options.schemas();

    const secrets = request.keys.filter((key) => schemas.isSecret(request.service, key));
    if (secrets.length > 0) {
      return err({
        code: 'invalid',
        detail: `cannot promote a secret (${secrets.join(', ')}) — set it directly in ${request.to}`,
      });
    }

    const tree = await this.options.loader.resolve(await this.options.repository.readSources());
    const source = tree.namespaces.get(from);
    if (!source) return err({ code: 'invalid', detail: `${from} has no configuration` });

    const missing = request.keys.filter((key) => !(key in source));
    if (missing.length > 0) {
      return err({ code: 'invalid', detail: `${from} does not set: ${missing.join(', ')}` });
    }

    const changes: Record<string, unknown> = {};
    for (const key of request.keys) changes[key] = source[key];

    return this.stage({ service: request.service, environment: request.to, changes }, actor);
  }

  /** Schema-secret keys that survived encryption as readable text. */
  private secretsLeftInPlaintext(service: string, config: RawConfig, encrypted: string): string[] {
    const schemas = this.options.schemas();
    const document = parseShallow(encrypted);
    return Object.keys(config).filter(
      (key) => schemas.isSecret(service, key) && !ENCRYPTED.test(document[key] ?? ''),
    );
  }
}

/** Applies the requested changes, reporting which keys actually moved. */
function applyChanges(
  current: RawConfig,
  changes: Readonly<Record<string, unknown>>,
): { next: Record<string, unknown>; changes: KeyChange[] } {
  const next: Record<string, unknown> = { ...current };
  const applied: KeyChange[] = [];

  for (const [key, newValue] of Object.entries(changes)) {
    const oldValue = current[key];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

    if (newValue === undefined) {
      delete next[key];
    } else {
      next[key] = newValue;
    }
    applied.push({ key, oldValue, newValue });
  }

  return { next, changes: applied };
}

/** Later entries win, so a re-edited key appears once with its newest value. */
function dedupeByKey(changes: readonly DraftChange[]): DraftChange[] {
  const byKey = new Map<string, DraftChange>();
  for (const change of changes) byKey.set(change.key, change);
  return [...byKey.values()];
}

function sortKeys(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
}

/** Top-level `key: value` pairs as raw text, enough to tell ciphertext from plaintext. */
function parseShallow(document: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of document.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (match?.[1]) pairs[match[1]] = match[2] ?? '';
  }
  return pairs;
}
