import { logCaught } from '@config/src/logging.js';
import type { Socket } from 'node:net';
import type { PeerCredentialResolver } from './peercred.js';
import type { ServiceRegistry } from './registry.js';
import { err, type Namespace, ok, type Result, type ServiceIdentity } from './types.js';

/**
 * The single decision point. Every read of every namespace goes through `authorize`, so this
 * file's properties are the service's security properties:
 *
 *  - it fails closed — a mechanism that cannot answer denies
 *  - denials are identical to the caller and specific in the log, so the endpoint is not an
 *    oracle for which uids and namespaces exist
 *  - the first denial of a kind alerts; a retry loop behind it does not page all night
 */

export type DenialReason = 'credentials_unreadable' | 'unknown_uid' | 'namespace_not_granted';

export interface AccessAuditEntry {
  readonly outcome: 'allowed' | 'denied';
  readonly uid: number | null;
  readonly service: string | null;
  readonly namespace: Namespace;
  readonly reason: DenialReason | null;
}

export interface Denied {
  readonly status: 403;
  readonly code: 'forbidden';
  readonly title: string;
  readonly detail: string;
}

/**
 * One frozen denial for every rejection path. Sharing the value is what guarantees the
 * responses are indistinguishable — a per-reason message would leak the reason.
 */
const DENIED: Denied = Object.freeze({
  status: 403,
  code: 'forbidden',
  title: 'Forbidden',
  detail: 'Access denied.',
});

export interface AccessGuardOptions {
  readonly resolver: PeerCredentialResolver;
  /**
   * Asked for the table on every check, not handed one at construction.
   *
   * The grant table changes when someone commits `services.yaml`, and holding one instance for
   * the process lifetime meant a revocation took effect only on a restart — while the same
   * reload made that commit's values live.
   */
  readonly registry: () => ServiceRegistry;
  readonly audit: (entry: AccessAuditEntry) => void;
  readonly alert: (entry: AccessAuditEntry) => void;
}

export class AccessGuard {
  private readonly alerted = new Set<string>();

  constructor(private readonly options: AccessGuardOptions) {}

  authorize(socket: Socket, namespace: Namespace): Result<ServiceIdentity, Denied> {
    let uid: number;
    try {
      uid = this.options.resolver.resolve(socket).uid;
    } catch (error) {
      logCaught(error, 'config.access.credentials.failed', { logger: 'identity.access-guard' });
      return this.deny({
        outcome: 'denied',
        uid: null,
        service: null,
        namespace,
        reason: 'credentials_unreadable',
      });
    }

    const registry = this.options.registry();
    const service = registry.identify(uid);
    if (!service) {
      return this.deny({ outcome: 'denied', uid, service: null, namespace, reason: 'unknown_uid' });
    }

    if (!registry.mayRead(service, namespace)) {
      return this.deny({
        outcome: 'denied',
        uid,
        service: service.name,
        namespace,
        reason: 'namespace_not_granted',
      });
    }

    // Allowed reads are logged too, so the trail answers "who read this key", not only
    // "who was turned away".
    this.options.audit({ outcome: 'allowed', uid, service: service.name, namespace, reason: null });
    return ok(service);
  }

  private deny(entry: AccessAuditEntry): Result<never, Denied> {
    this.options.audit(entry);

    // The socket is unreachable from the internet, so a denial means something on this host is
    // misconfigured or compromised — worth waking someone once per distinct fact.
    const key = `${entry.uid ?? 'none'}:${entry.namespace}:${entry.reason}`;
    if (!this.alerted.has(key)) {
      this.alerted.add(key);
      this.options.alert(entry);
    }

    return err(DENIED);
  }
}
