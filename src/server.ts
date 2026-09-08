import pino from 'pino';
import { parse as parseYaml } from 'yaml';
import { buildReadApi, buildWebApp, buildWebhookApp } from './app.js';
import { BreakGlass, type BreakGlassRecord } from './auth/break-glass.js';
import { OidcClient } from './auth/oidc.js';
import { SessionCodec } from './auth/session.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { GitRepository } from './git/repository.js';
import { GitSyncer } from './git/syncer.js';
import { AccessGuard } from './identity/access-guard.js';
import { PeerCredentialResolver, platformPeerCredentialReader } from './identity/peercred.js';
import { ServiceRegistry } from './identity/registry.js';
import { SchemaSet } from './schema/validator.js';
import { ConfigCache } from './store/cache.js';
import { DraftStore } from './store/draft-store.js';
import { EnvironmentOrder } from './store/environment-order.js';
import { ConfigLoader } from './store/loader.js';
import { SnapshotStore } from './store/snapshot.js';
import { SopsDecryptor } from './store/sops.js';
import { SopsEncryptor } from './store/sops-encryptor.js';
import { ConfigWriteService } from './store/write-service.js';

/**
 * Boot.
 *
 * Two listeners with deliberately different exposure: the read API on a Unix socket that no
 * packet from the network can reach, and the UI on a TCP port that Caddy fronts. They are
 * separate servers rather than one with a path prefix, because a routing mistake in a single
 * server would put `/config/...` on the internet.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });

  const repository = new GitRepository(config.repoDir, config.ssh ?? undefined);
  // Before anything is served, and never fatal: a registry that cannot reach its remote still
  // serves what it has, and the push failure shows up where an operator will see it.
  await repository.ensureRemote(config.gitRemote);
  if (config.gitRemote) log.info({ remote: config.gitRemote }, 'publishing to remote');
  const decryptor = new SopsDecryptor(config.ageKey);
  const loader = new ConfigLoader(decryptor);
  const cache = new ConfigCache();
  const snapshots = new SnapshotStore(config.snapshotPath);
  // Unpublished edits. Beside the snapshot rather than in the repo: a draft is not a commit.
  const drafts = new DraftStore(config.draftsPath);

  // The repo first; the snapshot only if it cannot be read. A snapshot that loaded over good
  // data would serve yesterday's config after a successful start.
  try {
    const sources = await repository.readSources();
    cache.reload(await loader.resolve(sources));
    await snapshots.save(sources);
    log.info({ commit: cache.commit() }, 'loaded configuration from the repository');
  } catch (error) {
    log.error({ err: error }, 'could not read the repository; falling back to the last snapshot');
    const snapshot = await snapshots.load();
    if (snapshot) {
      cache.reload(await loader.resolve(snapshot));
      log.warn({ commit: cache.commit() }, 'serving the last known good configuration');
    } else {
      log.warn('no configuration available; services will use their compiled-in defaults');
    }
  }

  const schemas = () => SchemaSet.fromFiles({});
  const loadSchemas = async () => SchemaSet.fromFiles(await repository.readSchemas());

  const readApi = await buildReadApi({
    cache,
    guard: new AccessGuard({
      resolver: new PeerCredentialResolver(platformPeerCredentialReader()),
      registry: ServiceRegistry.fromYaml(await readServicesYaml(repository)),
      audit: (entry) => log.info({ ...entry, event: 'authorize' }),
      alert: (entry) => log.warn({ ...entry, event: 'access_denied' }),
    }),
    onRead: (entry) => log.info({ ...entry, event: 'config_read' }),
  });
  await readApi.listen(config.socketPath);
  log.info({ socket: config.socketPath }, 'read API listening');

  let currentSchemas = await loadSchemas().catch(() => schemas());
  const web = await buildWebApp({
    repository,
    loader,
    schemas: () => currentSchemas,
    drafts,
    // Read per request, so declaring an order takes effect without a restart. Absent means
    // promotion is not offered at all rather than inferred from environment names.
    environmentOrder: async () => {
      try {
        return EnvironmentOrder.fromYaml(await repository.readFile('environments.yaml'));
      } catch {
        return EnvironmentOrder.none();
      }
    },
    writeService: new ConfigWriteService({
      repository,
      loader,
      encryptor: new SopsEncryptor(config.repoDir),
      schemas: () => currentSchemas,
      drafts,
    }),
    environment: config.environment,
    auth: config.sessionSecret
      ? {
          codec: new SessionCodec(config.sessionSecret),
          breakGlass: new BreakGlass({
            record: await readBreakGlassRecord(repository, decryptor, config, log),
            isIamReachable: () => isIamReachable(config),
            alert: (entry) => log.warn({ ...entry, event: 'break_glass' }),
          }),
          isIamReachable: () => isIamReachable(config),
          ...(config.iam ? { oidc: new OidcClient(config.iam) } : {}),
        }
      : undefined,
    logger: log,
  });
  await web.listen({ host: config.httpHost, port: config.httpPort });
  log.info({ host: config.httpHost, port: config.httpPort }, 'configuration UI listening');

  /**
   * Pull, reload, and let every waiting service know.
   *
   * The fan-out is not a broadcast: services hold a request open on the read socket and the
   * cache's own reload wakes them. So this function does nothing about notification beyond
   * calling reload, which is the point — config holds no addresses for its consumers.
   */
  const reloadFromRepository = async (): Promise<boolean> => {
    const sources = await repository.readSources();
    if (sources.commit === cache.commit()) return false;
    cache.reload(await loader.resolve(sources));
    currentSchemas = await loadSchemas();
    await snapshots.save(sources);
    log.info({ commit: sources.commit }, 'reloaded configuration');
    return true;
  };

  const webhooks = await buildWebhookApp({
    secret: config.webhookSecret,
    onPush: async () => {
      await repository.pull();
      await reloadFromRepository();
    },
    onError: (error) => log.error({ err: error }, 'webhook pull failed'),
    logger: log,
  });
  await webhooks.listen({ host: '0.0.0.0', port: config.webhookPort });
  log.info({ port: config.webhookPort }, 'webhook listener started');

  // A missed webhook self-heals, and unpushed commits publish themselves once GitHub returns.
  const syncer = new GitSyncer(repository);
  const retry = setInterval(() => {
    void syncer.retryUnpushed().then((result) => {
      if (result.pushed) log.info({ commits: result.commits }, 'published pending commits');
    });
  }, config.pushRetryIntervalMs);

  // The fallback for a webhook that never arrived — a delivery GitHub dropped, or an outage
  // while it was sent. Without it a missed webhook means stale config until someone notices.
  const reload = setInterval(() => {
    void (async () => {
      try {
        await repository.pull().catch(() => undefined);
        await reloadFromRepository();
      } catch (error) {
        log.error({ err: error }, 'reload failed; continuing to serve the current configuration');
      }
    })();
  }, config.pollIntervalMs);

  const shutdown = async () => {
    clearInterval(retry);
    clearInterval(reload);
    await readApi.close();
    await web.close();
    await webhooks.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Whether iam is answering.
 *
 * With no health URL configured the answer is "yes". Defaulting the other way would leave
 * break-glass permanently open on any instance that forgot to set it, which is precisely the
 * failure this gate exists to prevent.
 */
async function isIamReachable(config: ServiceConfig): Promise<boolean> {
  if (!config.iamHealthUrl) return true;
  try {
    const response = await fetch(config.iamHealthUrl, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The break-glass record, read from the config repository and decrypted in memory.
 *
 * Not circular: this reads the repository directly rather than through this service's own
 * socket API, so it still works during the iam outage the credential exists for.
 */
async function readBreakGlassRecord(
  repository: GitRepository,
  decryptor: SopsDecryptor,
  config: ServiceConfig,
  log: { warn: (o: object, m: string) => void },
): Promise<BreakGlassRecord | null> {
  try {
    const source = await repository.readFile(config.breakGlassPath);
    const parsed = parseYaml(
      await decryptor.decrypt(config.breakGlassPath, source),
    ) as Partial<BreakGlassRecord>;
    if (!parsed?.passwordHash || !parsed.totpSecret || !parsed.actorEmail) {
      throw new Error('the break-glass record is missing fields');
    }
    return {
      passwordHash: parsed.passwordHash,
      totpSecret: parsed.totpSecret,
      actorEmail: parsed.actorEmail,
    };
  } catch (error) {
    // Absent is a legitimate state, and BreakGlass refuses every attempt when the record is
    // null — so a missing file locks the door rather than leaving it open.
    log.warn(
      { err: error },
      'no break-glass record; break-glass sign-in will refuse every attempt',
    );
    return null;
  }
}

/** The grant table. Absent means no service may read anything, which fails closed. */
async function readServicesYaml(repository: GitRepository): Promise<string> {
  try {
    return await repository.readFile('services.yaml');
  } catch {
    return 'services:\n  - name: none\n    uid: 65534\n    namespaces: [none/none]\n';
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
