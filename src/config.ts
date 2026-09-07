/**
 * Configuration for the config service itself, which by principle 4 comes from the environment.
 *
 * This service cannot read its own registry to find out where its registry is.
 */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export interface ServiceConfig {
  readonly environment: string;
  readonly repoDir: string;
  readonly socketPath: string;
  readonly snapshotPath: string;
  readonly ageKey: string;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly logLevel: string;
  readonly authenticated: boolean;
  readonly pushRetryIntervalMs: number;
  readonly pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const environment = env.CONFIG_ENVIRONMENT ?? 'dev';

  return {
    environment,
    repoDir: env.CONFIG_REPO_DIR ?? '/var/lib/config/repo',
    socketPath: env.CONFIG_SOCKET_PATH ?? '/run/config/config.sock',
    snapshotPath: env.CONFIG_SNAPSHOT_PATH ?? '/var/lib/config/snapshot.json',
    // Needed to decrypt anything, including the last-known-good snapshot at boot.
    ageKey: environment === 'prod' ? required('CONFIG_AGE_KEY') : (env.CONFIG_AGE_KEY ?? ''),
    // Loopback by default. The UI has no authentication until slice 10, and 0.0.0.0 would put
    // it on the Docker network where every container could reach it.
    httpHost: env.CONFIG_HTTP_HOST ?? '127.0.0.1',
    httpPort: Number(env.CONFIG_HTTP_PORT ?? 8200),
    logLevel: env.CONFIG_LOG_LEVEL ?? 'info',
    // Slice 10 sets this once iam OIDC and break-glass exist.
    authenticated: env.CONFIG_AUTHENTICATED === 'true',
    pushRetryIntervalMs: Number(env.CONFIG_PUSH_RETRY_INTERVAL_MS ?? 60_000),
    pollIntervalMs: Number(env.CONFIG_POLL_INTERVAL_MS ?? 60_000),
  };
}
