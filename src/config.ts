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
  readonly sessionSecret: string;
  readonly iam: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } | null;
  readonly iamHealthUrl: string | null;
  readonly breakGlassPath: string;
  readonly webhookSecret: string | null;
  readonly webhookPort: number;
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
    // Signing key for the session cookie. Required in prod: without it the editor cannot be
    // guarded, and buildWebApp refuses to serve it unguarded there anyway.
    sessionSecret:
      environment === 'prod'
        ? required('CONFIG_SESSION_SECRET')
        : (env.CONFIG_SESSION_SECRET ?? ''),
    iam:
      env.CONFIG_IAM_ISSUER && env.CONFIG_IAM_CLIENT_ID && env.CONFIG_IAM_CLIENT_SECRET
        ? {
            issuer: env.CONFIG_IAM_ISSUER,
            clientId: env.CONFIG_IAM_CLIENT_ID,
            clientSecret: env.CONFIG_IAM_CLIENT_SECRET,
            redirectUri: env.CONFIG_IAM_REDIRECT_URI ?? 'https://config.anudeep.pro/login/callback',
          }
        : null,
    // How reachability is decided. Break-glass opens only when this fails, so an unset value
    // must mean "reachable" — never "assume down and open the emergency door".
    iamHealthUrl: env.CONFIG_IAM_HEALTH_URL ?? null,
    breakGlassPath: env.CONFIG_BREAK_GLASS_PATH ?? 'break-glass.yaml',
    // Null closes the webhook route. It is the one thing here the internet can reach, so an
    // unset secret must lock it rather than open it.
    webhookSecret: env.CONFIG_WEBHOOK_SECRET ?? null,
    webhookPort: Number(env.CONFIG_WEBHOOK_PORT ?? 8201),
    pushRetryIntervalMs: Number(env.CONFIG_PUSH_RETRY_INTERVAL_MS ?? 60_000),
    pollIntervalMs: Number(env.CONFIG_POLL_INTERVAL_MS ?? 60_000),
  };
}
