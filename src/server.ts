import pino from 'pino';
import { buildReadApi, buildWebApp } from './app.js';
import { loadConfig } from './config.js';
import { GitRepository } from './git/repository.js';
import { GitSyncer } from './git/syncer.js';
import { AccessGuard } from './identity/access-guard.js';
import { PeerCredentialResolver, platformPeerCredentialReader } from './identity/peercred.js';
import { ServiceRegistry } from './identity/registry.js';
import { SchemaSet } from './schema/validator.js';
import { ConfigCache } from './store/cache.js';
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

  const repository = new GitRepository(config.repoDir);
  const decryptor = new SopsDecryptor(config.ageKey);
  const loader = new ConfigLoader(decryptor);
  const cache = new ConfigCache();
  const snapshots = new SnapshotStore(config.snapshotPath);

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
    writeService: new ConfigWriteService({
      repository,
      loader,
      encryptor: new SopsEncryptor(config.repoDir),
      schemas: () => currentSchemas,
    }),
    environment: config.environment,
    authenticated: config.authenticated,
    logger: log,
  });
  await web.listen({ host: config.httpHost, port: config.httpPort });
  log.info({ host: config.httpHost, port: config.httpPort }, 'configuration UI listening');

  // A missed webhook self-heals, and unpushed commits publish themselves once GitHub returns.
  const syncer = new GitSyncer(repository);
  const retry = setInterval(() => {
    void syncer.retryUnpushed().then((result) => {
      if (result.pushed) log.info({ commits: result.commits }, 'published pending commits');
    });
  }, config.pushRetryIntervalMs);

  const reload = setInterval(() => {
    void (async () => {
      try {
        const sources = await repository.readSources();
        if (sources.commit === cache.commit()) return;
        cache.reload(await loader.resolve(sources));
        currentSchemas = await loadSchemas();
        await snapshots.save(sources);
        log.info({ commit: sources.commit }, 'reloaded configuration');
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
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
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
