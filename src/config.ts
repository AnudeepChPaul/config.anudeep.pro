import { webUrlFor } from './git/repository.js';

/**
 * Configuration for the config service itself, which by principle 4 comes from the environment.
 *
 * This service cannot read its own registry to find out where its registry is.
 */

const required = (name: string, env: NodeJS.ProcessEnv = process.env): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export interface ServiceConfig {
  readonly environment: string;
  readonly repoDir: string;
  /** Where published commits go. Null is a deliberately local registry with no off-host copy. */
  readonly gitRemote: string | null;
  /**
   * Where this repository lives in a browser, for linking the commit being served. Derived from
   * the remote when there is one; settable on its own, because linking a commit is a read and
   * needs neither a deploy key nor a configured push.
   */
  readonly repoWebUrl: string | null;
  /** The deploy key git pushes with. Null means whatever ssh the host provides — or none. */
  readonly ssh: { readonly keyPath: string; readonly knownHostsPath?: string } | null;
  readonly socketPath: string;
  readonly snapshotPath: string;
  readonly draftsPath: string;
  readonly ageKey: string;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly logLevel: string;
  readonly sessionSecret: string;
  /** True only where the operator explicitly gave up the secure cookie, and never in prod. */
  readonly insecureCookie: boolean;
  readonly iam: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } | null;
  readonly iamHealthUrl: string | null;
  readonly iamCheckIntervalMs: number;
  readonly breakGlassPath: string;
  readonly webhookSecret: string | null;
  readonly webhookPort: number;
  readonly pushRetryIntervalMs: number;
  readonly pollIntervalMs: number;
  /** Whether the settings page exists at all. Off, its route answers 404 like any other path. */
  readonly enableSettings: boolean;
  /** Addresses admitted to it beside a break-glass session. Lowercased; empty admits nobody. */
  readonly settingsAllow: readonly string[];
}

/** The environments this service knows how to be. Anything else is a misconfiguration. */
const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  // Unset means dev, which is the documented default for someone running it locally. Anything
  // else must be one of the three: an empty string — what an unset compose interpolation
  // produces — used to be neither dev nor prod, and every production guard hung off that one
  // comparison. A value nobody recognises is a misconfiguration, and this is the one place that
  // can still say so out loud.
  const environment = env.CONFIG_ENVIRONMENT ?? 'dev';
  if (!ENVIRONMENTS.includes(environment as (typeof ENVIRONMENTS)[number])) {
    throw new Error(
      `CONFIG_ENVIRONMENT must be one of ${ENVIRONMENTS.join(', ')}; got '${environment}'`,
    );
  }

  return {
    environment,
    repoDir: env.CONFIG_REPO_DIR ?? '/var/lib/config/repo',
    // The repository is created locally, by the seed script or a first boot, and nothing in git
    // carries a remote across that. Unset, every publish is durable and pushed nowhere.
    gitRemote: env.CONFIG_GIT_REMOTE ?? null,
    repoWebUrl: env.CONFIG_REPO_WEB_URL ?? webUrlFor(env.CONFIG_GIT_REMOTE ?? null),
    // All or nothing: a key without the rest is still a working ssh invocation, but a
    // known_hosts without a key leaves git free to offer whatever key the box holds and
    // authenticate as somebody else.
    ssh: env.CONFIG_GIT_SSH_KEY
      ? {
          keyPath: env.CONFIG_GIT_SSH_KEY,
          ...(env.CONFIG_GIT_KNOWN_HOSTS ? { knownHostsPath: env.CONFIG_GIT_KNOWN_HOSTS } : {}),
        }
      : null,
    socketPath: env.CONFIG_SOCKET_PATH ?? '/run/config/config.sock',
    snapshotPath: env.CONFIG_SNAPSHOT_PATH ?? '/var/lib/config/snapshot.json',
    draftsPath: env.CONFIG_DRAFTS_PATH ?? '/var/lib/config/drafts.json',
    // Needed to decrypt anything, including the last-known-good snapshot at boot — in every
    // environment, not only prod. Required here rather than gated on the environment, because
    // gating it on one string is how it came to be optional by accident.
    ageKey: required('CONFIG_AGE_KEY', env),
    // Loopback by default. The UI has no authentication until slice 10, and 0.0.0.0 would put
    // it on the Docker network where every container could reach it.
    httpHost: env.CONFIG_HTTP_HOST ?? '127.0.0.1',
    httpPort: Number(env.CONFIG_HTTP_PORT ?? 8200),
    logLevel: env.CONFIG_LOG_LEVEL ?? 'info',
    // Signing key for the session cookie, in every environment. Its absence used to make the
    // auth options undefined, and an undefined auth was allowed anywhere but prod — so one
    // unset variable served the console with no login on it.
    sessionSecret: required('CONFIG_SESSION_SECRET', env),
    // The one opt-out, for a developer on plain http. Refused in prod whatever is asked for:
    // a session cookie that can travel in clear is not a session.
    insecureCookie: environment !== 'prod' && env.CONFIG_INSECURE_COOKIE === '1',
    iam:
      env.CONFIG_IAM_ISSUER && env.CONFIG_IAM_CLIENT_ID && env.CONFIG_IAM_CLIENT_SECRET
        ? {
            issuer: env.CONFIG_IAM_ISSUER,
            clientId: env.CONFIG_IAM_CLIENT_ID,
            clientSecret: env.CONFIG_IAM_CLIENT_SECRET,
            redirectUri: env.CONFIG_IAM_REDIRECT_URI ?? 'https://config.anudeep.pro/login/callback',
          }
        : null,
    // Break-glass opens only when this fails; default to the local IAM health endpoint rather
    // than assuming IAM is reachable and leaving the monitor disconnected.
    // IAM runs on port 8000 by default. Keep the URL configurable for containers or hosts
    // where the health endpoint is exposed elsewhere.
    iamHealthUrl: env.CONFIG_IAM_HEALTH_URL?.trim() || 'http://127.0.0.1:8000/healthz',
    iamCheckIntervalMs: Number(env.CONFIG_IAM_CHECK_INTERVAL_MS ?? 10_000),
    // Absolute, so it lives beside the repository rather than inside it: a committed credential
    // is a pushable credential, and it reached a remote once already. A relative value still
    // works and still means a path in the tree, for a volume seeded before this changed.
    breakGlassPath: env.CONFIG_BREAK_GLASS_PATH ?? '/var/lib/config/break-glass.yaml',
    // Null closes the webhook route. It is the one thing here the internet can reach, so an
    // unset secret must lock it rather than open it.
    webhookSecret: env.CONFIG_WEBHOOK_SECRET ?? null,
    webhookPort: Number(env.CONFIG_WEBHOOK_PORT ?? 8201),
    pushRetryIntervalMs: Number(env.CONFIG_PUSH_RETRY_INTERVAL_MS ?? 60_000),
    pollIntervalMs: Number(env.CONFIG_POLL_INTERVAL_MS ?? 60_000),
    // The settings page shows a map of the deployment, so its default is "not there". Read as a
    // set of words that plainly mean yes rather than as truthiness: `Boolean('false')` is true,
    // which is how a flag ends up on in production while the file says it is off.
    enableSettings: ['1', 'true', 'yes', 'on'].includes(
      (env.CONFIG_ENABLE_SETTINGS ?? '').trim().toLowerCase(),
    ),
    // Empty admits nobody, never everybody: an allowlist whose empty case is "allow all" is a
    // disclosure the first time someone enables the toggle without filling this in.
    settingsAllow: (env.CONFIG_SETTINGS_ALLOW ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  };
}
