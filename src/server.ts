import { readFile as readFileFromDisk } from 'node:fs/promises';
import { dirname } from 'node:path';
import pino from 'pino';
import { buildReadApi, buildWebApp, buildWebhookApp } from './app.js';
import { BreakGlass } from './auth/break-glass.js';
import { OidcClient } from './auth/oidc.js';
import { SessionCodec } from './auth/session.js';
import { breakGlassReader } from './boot/break-glass-source.js';
import { RepositoryState } from './boot/repository-state.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { prepareDeployKey } from './git/deploy-key.js';
import { GitRepository } from './git/repository.js';
import { GitSyncer } from './git/syncer.js';
import { AccessGuard } from './identity/access-guard.js';
import { PeerCredentialResolver, platformPeerCredentialReader } from './identity/peercred.js';
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

  // Beside the repository and the age key, which is already the private state directory of
  // this service: a 0600 copy of the deploy key, because ssh refuses one the mount leaves
  // readable by others.
  const keyPath = await prepareDeployKey(config.ssh?.keyPath, dirname(config.repoDir));
  const ssh =
    config.ssh && keyPath
      ? { ...config.ssh, keyPath }
      : config.ssh?.keyPath
        ? undefined
        : config.ssh;
  if (config.ssh?.keyPath && !keyPath) {
    log.warn({ key: config.ssh.keyPath }, 'deploy key unreadable; pushes will fail');
  }

  const repository = new GitRepository(config.repoDir, ssh ?? undefined);
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

  // One object holding everything read out of the repository, rebuilt on every reload. The
  // registry used to be read once at boot: a reload made a commit's VALUES live while leaving
  // its grant table untouched, so a revocation had no effect until a restart — and a change
  // that rotates a secret and revokes a grant together handed the new secret to exactly the uid
  // it was being taken from.
  const state = new RepositoryState({
    // An absolute break-glass path is read from the volume rather than the tree, so the
    // credential cannot be committed and therefore cannot be pushed. Everything else, and a
    // relative path, still comes from the served commit.
    readFile: breakGlassReader({
      fromRepository: (path) => repository.readFile(path),
      fromFilesystem: (path) => readFileFromDisk(path, 'utf8'),
    }),
    loadSchemas: () => repository.readSchemas(),
    decrypt: (path, source) => decryptor.decrypt(path, source),
    breakGlassPath: config.breakGlassPath,
    onCache: async () => {
      const sources = await repository.readSources();
      cache.reload(await loader.resolve(sources));
      await snapshots.save(sources);
    },
    onError: (what, error) =>
      log.warn({ err: error, what }, 'could not reload from the repository'),
  });
  await state.reload();

  const readApi = await buildReadApi({
    cache,
    // Asked per request, like the grant table: a product marked retiring must be reported as
    // retiring without waiting for a restart, which is the whole point of telling consumers.
    isRetiring: (service) => state.schemas().isRetiring(service),
    guard: new AccessGuard({
      resolver: new PeerCredentialResolver(platformPeerCredentialReader()),
      // Asked per check: a revocation must not wait for a restart.
      registry: () => state.registry(),
      audit: (entry) => log.info({ ...entry, event: 'authorize' }),
      alert: (entry) => log.warn({ ...entry, event: 'access_denied' }),
    }),
    onRead: (entry) => log.info({ ...entry, event: 'config_read' }),
  });
  await readApi.listen(config.socketPath);
  log.info({ socket: config.socketPath }, 'read API listening');

  const web = await buildWebApp({
    repository,
    // This console writes to the repository it reads from, so it has to look again afterwards.
    // Values come from git per request and appeared immediately; the grant table and the schemas
    // live in RepositoryState and refreshed only on a webhook or the poll — so a published
    // retirement, a new product, an archive, all changed nothing on screen for up to a minute.
    onCommitted: async () => {
      await state.reload();
    },
    // The console lists what the registry declares, so both halves of the service — the read API
    // and the editor — agree on what exists.
    services: () => state.registry().services(),
    repoWebUrl: config.repoWebUrl,
    // Off unless the deployment says otherwise, and then only for a break-glass session or a
    // named address: this page is a map of how the service is configured.
    settings: { enabled: config.enableSettings, allow: config.settingsAllow },
    loader,
    schemas: () => state.schemas(),
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
      schemas: () => state.schemas(),
      drafts,
    }),
    environment: config.environment,
    auth: config.sessionSecret
      ? {
          codec: new SessionCodec(config.sessionSecret),
          breakGlass: new BreakGlass({
            // Read through the state, so rotating or deleting the record takes effect on the
            // next reload rather than on the next restart.
            record: state.breakGlassRecord(),
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
    // Everything the repository declares, in one place and in one order: the grant table first,
    // then the schemas and the break-glass record, then the values themselves.
    await state.reload();
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

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
