import { parse as parseYaml } from 'yaml';
import type { BreakGlassRecord } from '../auth/break-glass.js';
import { ServiceRegistry } from '../identity/registry.js';
import { SchemaSet } from '../schema/validator.js';

/**
 * Everything the service reads out of the repository and has to keep current.
 *
 * The grant table used to be read once at boot. A reload refreshed the values and the schemas
 * and left it alone, so removing a namespace from a uid in `services.yaml` had no effect until
 * a restart — while the same reload made that commit's values live. A revocation and a secret
 * rotation usually arrive in one change, so the rotated secret reached exactly the uid the
 * change was taking it away from.
 *
 * Order matters and is the reason this is one object rather than three: the registry is rebuilt
 * BEFORE the values it governs, so a value is never readable by a uid the same commit revoked.
 */

export interface RepositoryStateOptions {
  /** Reads a path out of the repository at HEAD. Rejects when it is not there. */
  readonly readFile: (path: string) => Promise<string>;
  /** Loads and parses every schema. Called on each reload. */
  readonly loadSchemas: () => Promise<Record<string, string>>;
  /** Optional global schema source; preferred over legacy per-service files. */
  readonly loadSchemaDocument?: () => Promise<string>;
  /** Decrypts the break-glass record. Absent leaves the record unreadable, which locks it. */
  readonly decrypt?: (path: string, source: string) => Promise<string>;
  readonly breakGlassPath?: string;
  /** Reloads the served values. Called after the registry, never before. */
  readonly onCache?: () => void | Promise<void>;
  /** For observability in tests; production passes nothing. */
  readonly onRegistry?: () => void;
  readonly onError?: (what: string, error: Error) => void;
}

export class RepositoryState {
  /**
   * Until the first successful read: a table granting nothing, to a uid nothing runs as.
   *
   * The schema requires at least one service, and an empty grant is the honest starting point —
   * every read is refused until services.yaml has actually been read.
   */
  private currentRegistry = ServiceRegistry.fromYaml(
    'version: 1\nservices:\n  - name: none\n    uid: 65534\n    namespaces: [none/none]\n',
  );
  private currentSchemas = SchemaSet.fromFiles({});
  private currentRecord: BreakGlassRecord | null = null;

  constructor(private readonly options: RepositoryStateOptions) {}

  registry(): ServiceRegistry {
    return this.currentRegistry;
  }

  schemas(): SchemaSet {
    return this.currentSchemas;
  }

  breakGlassRecord(): BreakGlassRecord | null {
    return this.currentRecord;
  }

  /**
   * Rereads everything. Never throws: a transient read error must not take the service down.
   *
   * A part that cannot be read keeps its last known good value — denying every service on a
   * failed read would be an outage, and guessing would be worse. The break-glass record is the
   * exception: a record that has been DELETED must stop working, so an absent file clears it
   * while an unreadable one keeps it.
   */
  async reload(): Promise<void> {
    await this.reloadRegistry();
    await this.reloadSchemas();
    await this.reloadBreakGlass();
    // After the registry, always: the values a commit publishes must never become readable
    // ahead of the grants that same commit changed.
    await this.options.onCache?.();
  }

  private async reloadRegistry(): Promise<void> {
    try {
      const source = await this.options.readFile('services.yaml');
      this.currentRegistry = ServiceRegistry.fromYaml(source);
      this.options.onRegistry?.();
    } catch (error) {
      this.options.onError?.('services.yaml', error as Error);
    }
  }

  private async reloadSchemas(): Promise<void> {
    try {
      if (this.options.loadSchemaDocument) {
        try {
          this.currentSchemas = SchemaSet.fromDocument(await this.options.loadSchemaDocument());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.currentSchemas = SchemaSet.fromFiles(await this.options.loadSchemas());
        }
      } else {
        this.currentSchemas = SchemaSet.fromFiles(await this.options.loadSchemas());
      }
    } catch (error) {
      this.options.onError?.('schemas', error as Error);
    }
  }

  private async reloadBreakGlass(): Promise<void> {
    const path = this.options.breakGlassPath;
    if (!path) return;

    let source: string;
    try {
      source = await this.options.readFile(path);
    } catch (error) {
      // Gone from the repository: the credential is revoked, and keeping it would mean a
      // deletion did nothing.
      this.currentRecord = null;
      this.options.onError?.(path, error as Error);
      return;
    }

    try {
      const decrypted = this.options.decrypt ? await this.options.decrypt(path, source) : source;
      const parsed = parseYaml(decrypted) as Partial<BreakGlassRecord>;
      if (!parsed?.passwordHash || !parsed.totpSecret || !parsed.actorEmail) {
        throw new Error('the break-glass record is missing fields');
      }
      this.currentRecord = {
        passwordHash: parsed.passwordHash,
        totpSecret: parsed.totpSecret,
        actorEmail: parsed.actorEmail,
      };
    } catch (error) {
      // Present but unreadable — a decryption failure, a truncated file. Keeping the last good
      // record is the safe direction: the alternative locks out the emergency path during what
      // is already an emergency.
      this.options.onError?.(path, error as Error);
    }
  }
}
