/**
 * What this service is configured with.
 *
 * The page exists because a misconfiguration had no symptom. CONFIG_GIT_REMOTE was empty for a
 * whole session and the only sign was publishing reporting "not yet pushed" forever, as though it
 * were a transient state; CONFIG_AGE_KEY held a public recipient rather than a secret key, which
 * looks identical from the outside until something tries to decrypt. Both were minutes of work to
 * fix and hours to notice, because nothing in the console said what it was running with.
 *
 * It is also the one page that reads the process environment, which makes it the one page that
 * can leak everything at once: the age key decrypts the whole registry, and the session secret
 * forges any operator. So masking is a CLASSIFICATION, not a decision made per variable at the
 * point of rendering. A name containing one of the secret markers below is secret, which means a
 * variable added later is covered without anyone remembering to cover it.
 */

/** Everything the service reads, in the order a reader would want it. */
const KNOWN: readonly string[] = [
  'CONFIG_ENVIRONMENT',
  'CONFIG_LOG_LEVEL',
  'CONFIG_HTTP_HOST',
  'CONFIG_HTTP_PORT',
  'CONFIG_REPO_DIR',
  'CONFIG_GIT_REMOTE',
  'CONFIG_REPO_WEB_URL',
  'CONFIG_GIT_SSH_KEY',
  'CONFIG_GIT_KNOWN_HOSTS',
  'CONFIG_AGE_KEY',
  'CONFIG_SNAPSHOT_PATH',
  'CONFIG_DRAFTS_PATH',
  'CONFIG_SOCKET_PATH',
  'CONFIG_SESSION_SECRET',
  'CONFIG_INSECURE_COOKIE',
  'CONFIG_BREAK_GLASS_PATH',
  'CONFIG_IAM_ISSUER',
  'CONFIG_IAM_CLIENT_ID',
  'CONFIG_IAM_CLIENT_SECRET',
  'CONFIG_IAM_REDIRECT_URI',
  'CONFIG_IAM_HEALTH_URL',
  'CONFIG_WEBHOOK_SECRET',
  'CONFIG_WEBHOOK_PORT',
  'CONFIG_PUSH_RETRY_INTERVAL_MS',
  'CONFIG_POLL_INTERVAL_MS',
  'CONFIG_ENABLE_SETTINGS',
  'CONFIG_SETTINGS_ALLOW',
];

/**
 * What makes a name secret. Substrings rather than an allowlist of variables: the failure mode
 * worth designing against is a secret added later that nobody classifies, and a name ending in
 * SECRET or KEY is the one thing such a variable reliably has.
 */
const SECRET_MARKERS = ['SECRET', 'AGE_KEY', 'PASSWORD', 'TOKEN'];

const isSecret = (name: string): boolean => SECRET_MARKERS.some((marker) => name.includes(marker));

/** How much of a secret may be shown: enough to tell two keys apart, never enough to use. */
const PREFIX = 6;

export interface SettingsRow {
  readonly name: string;
  readonly secret: boolean;
  /** Whether the environment supplied a value at all. The distinction the console lacked. */
  readonly set: boolean;
  /** What may be rendered: the value, a masked prefix, or a statement that nothing is set. */
  readonly shown: string;
}

export function settingsRows(env: NodeJS.ProcessEnv): readonly SettingsRow[] {
  return KNOWN.map((name) => {
    const value = env[name];
    const set = value !== undefined && value !== '';
    const secret = isSecret(name);
    if (!set) return { name, secret, set: false, shown: 'not set' };
    // A prefix, never the value: enough to see WHICH key is loaded — the question that took a
    // session to answer — and useless to anyone reading it over a shoulder or in a screenshot.
    return {
      name,
      secret,
      set: true,
      shown: secret ? `${String(value).slice(0, PREFIX)}…` : String(value),
    };
  });
}
