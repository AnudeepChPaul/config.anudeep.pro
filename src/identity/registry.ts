import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { NAMESPACE_PATTERN } from '../namespace.js';
import type { Namespace, ServiceIdentity } from './types.js';

/**
 * The grant table, backed by `services.yaml` in the config repo.
 *
 * Every question this class answers is answered from the file, so a privilege change is a
 * reviewable commit rather than a deploy. Both questions are deliberately narrow: which service
 * is this uid, and may that service read this namespace.
 */

const ServiceSchema = z.object({
  name: z.string().min(1, 'service must have a name'),
  uid: z.int().nonnegative('uid must be a non-negative integer'),
  namespaces: z
    .array(z.string().regex(NAMESPACE_PATTERN, 'namespace must be "<service>/<environment>"'))
    .min(1, 'service must grant at least one namespace'),
});

const FileSchema = z.object({ services: z.array(ServiceSchema).min(1) });

export class ServiceRegistryError extends Error {}

export class ServiceRegistry {
  private readonly byUid: ReadonlyMap<number, ServiceIdentity>;

  private constructor(services: readonly ServiceIdentity[]) {
    const byUid = new Map<number, ServiceIdentity>();
    for (const service of services) {
      const clash = byUid.get(service.uid);
      if (clash) {
        // Unresolvable at request time — SO_PEERCRED reports a uid and the registry would have
        // to guess which grant applies. Fail at load, where a human is watching.
        throw new ServiceRegistryError(
          `services.yaml is invalid: uid ${service.uid} is claimed by both ` +
            `'${clash.name}' and '${service.name}'`,
        );
      }
      byUid.set(service.uid, service);
    }
    this.byUid = byUid;
  }

  static fromYaml(source: string): ServiceRegistry {
    const parsed = FileSchema.safeParse(parseYaml(source));
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ServiceRegistryError(`services.yaml is invalid: ${detail}`);
    }

    return new ServiceRegistry(
      parsed.data.services.map((s) =>
        Object.freeze({ ...s, namespaces: Object.freeze(s.namespaces) }),
      ),
    );
  }

  /** The service holding this uid, or null. Root is not special-cased: it holds no grant. */
  identify(uid: number): ServiceIdentity | null {
    return this.byUid.get(uid) ?? null;
  }

  /**
   * Exact membership, never prefix matching — `api/prod` must not imply `api/prod-eu`.
   *
   * The grant is re-read from the registry rather than from the passed identity, so a caller
   * that constructs its own `ServiceIdentity` gains nothing by widening the array on it.
   */
  mayRead(service: ServiceIdentity, namespace: Namespace): boolean {
    const known = this.byUid.get(service.uid);
    return known?.name === service.name && known.namespaces.includes(namespace);
  }
}
