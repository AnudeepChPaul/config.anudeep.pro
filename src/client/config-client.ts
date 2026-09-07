import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';

/**
 * The client every consuming service imports.
 *
 * Its whole job is to make configuration a non-dependency. Defaults are compiled in, the disk
 * cache covers a restart while config is down, and the socket fetch happens in the background —
 * so a service starts when config is down, when config has never existed, and when its own
 * cache is corrupt.
 *
 * The alternative is that one service on one box becomes a boot dependency for every other
 * service on the platform, including the ones you would need to fix it.
 */

export interface ConfigClientOptions {
  readonly socketPath: string;
  readonly service: string;
  readonly environment: string;
  /** Where to keep the last-known-good. Omit to opt out of caching entirely. */
  readonly cachePath?: string | undefined;
  readonly fetchTimeoutMs?: number;
  /** Called when a background refresh fails. Defaults to silence: this must never throw. */
  readonly onError?: (error: Error) => void;
}

interface CacheFile {
  service: string;
  environment: string;
  commit: string;
  config: Record<string, unknown>;
}

interface ServedConfig {
  commit: string;
  config: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export class ConfigClient<T extends Record<string, unknown>> {
  private defaults: T = {} as T;
  private resolved: T = {} as T;
  private currentCommit: string | null = null;
  private readonly handlers: Array<() => void> = [];

  constructor(private readonly options: ConfigClientOptions) {}

  /**
   * Returns immediately-usable configuration and never blocks on the network.
   *
   * Only local work is awaited — reading the cache file. The socket fetch is started and
   * deliberately not awaited, because a config service that accepts connections and then never
   * answers is precisely the state an overloaded box is in, and waiting for it would hang the
   * boot of every service behind it.
   */
  async load(defaults: T): Promise<T> {
    this.defaults = defaults;
    this.resolved = { ...defaults };

    const cached = await this.readCache();
    if (cached) {
      this.resolved = { ...defaults, ...cached.config };
      this.currentCommit = cached.commit;
    }

    void this.refresh().catch(() => {});

    return this.resolved;
  }

  /** The live configuration. Call this rather than holding what `load` returned. */
  current(): T {
    return this.resolved;
  }

  /** The commit the current values came from, or null while running on defaults alone. */
  commit(): string | null {
    return this.currentCommit;
  }

  /** Registered handlers run when a refresh brings a *different* commit. */
  onInvalidate(handler: () => void): void {
    this.handlers.push(handler);
  }

  /**
   * Fetches once. Resolves to whether anything changed; never rejects.
   *
   * Every failure — no socket, a refused namespace, a timeout, malformed JSON — leaves the
   * current values in place. Degrading to defaults on a transient error would silently undo
   * whatever was set during the last incident.
   */
  async refresh(): Promise<boolean> {
    let served: ServedConfig | null = null;
    try {
      served = await this.fetch();
    } catch (error) {
      this.options.onError?.(error as Error);
      return false;
    }

    if (!served) return false;

    this.resolved = { ...this.defaults, ...served.config };
    const changed = served.commit !== this.currentCommit;
    this.currentCommit = served.commit;

    await this.writeCache(served).catch((error: Error) => this.options.onError?.(error));

    if (changed) this.notify();
    return changed;
  }

  private notify(): void {
    for (const handler of this.handlers) {
      try {
        handler();
      } catch (error) {
        // One consumer's rebuild failing must not stop the others from being told.
        this.options.onError?.(error as Error);
      }
    }
  }

  private fetch(): Promise<ServedConfig | null> {
    const { socketPath, service, environment } = this.options;
    const timeout = this.options.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath, path: `/config/${service}/${environment}`, method: 'GET', timeout },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            // A 403 or 404 is an answer, not a failure: the grant is missing or the namespace
            // has no file. Either way the compiled-in defaults are the right values to keep.
            if (response.statusCode !== 200) return resolve(null);
            try {
              const parsed = JSON.parse(body) as ServedConfig;
              resolve({ commit: parsed.commit, config: parsed.config ?? {} });
            } catch (error) {
              reject(error as Error);
            }
          });
        },
      );

      request.on('timeout', () => request.destroy(new Error('config fetch timed out')));
      request.on('error', reject);
      request.end();
    });
  }

  private async readCache(): Promise<ServedConfig | null> {
    if (!this.options.cachePath) return null;

    let parsed: CacheFile;
    try {
      parsed = JSON.parse(await readFile(this.options.cachePath, 'utf8')) as CacheFile;
    } catch {
      // Absent or truncated. Neither is a reason to refuse to start.
      return null;
    }

    // A cache path shared by two services through a copy-pasted compose file would otherwise
    // feed one service the other's configuration.
    if (
      parsed?.service !== this.options.service ||
      parsed.environment !== this.options.environment
    ) {
      return null;
    }
    if (
      typeof parsed.commit !== 'string' ||
      typeof parsed.config !== 'object' ||
      parsed.config === null
    ) {
      return null;
    }

    return { commit: parsed.commit, config: parsed.config };
  }

  private async writeCache(served: ServedConfig): Promise<void> {
    const path = this.options.cachePath;
    if (!path) return;

    const file: CacheFile = {
      service: this.options.service,
      environment: this.options.environment,
      commit: served.commit,
      config: served.config,
    };
    // 0600: these values were decrypted by the server, so on this side they are plaintext and
    // must not be readable by other uids on the host.
    const temp = join(dirname(path), `.${process.pid}.config.tmp`);
    await writeFile(temp, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temp, path);
    } catch (cause) {
      await unlink(temp).catch(() => {});
      throw cause;
    }
  }
}
