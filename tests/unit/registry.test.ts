import { ServiceRegistry } from '@config/src/identity/registry.js';
import { describe, expect, it } from 'vitest';

/**
 * `services.yaml` is the privilege grant table — the file a reviewer reads to answer "who may
 * read what". These tests pin its parsing and its two questions: which service is this uid, and
 * may that service read this namespace.
 */

/** Fails the test loudly instead of asserting past a null the grant table should have held. */
const mustIdentify = (registry: ServiceRegistry, uid: number) => {
  const service = registry.identify(uid);
  if (!service) throw new Error(`expected uid ${uid} to be a known service`);
  return service;
};

const SERVICES_YAML = `
services:
  - name: iam
    uid: 1002
    namespaces: [iam/prod, iam/dev]
  - name: api
    uid: 1003
    namespaces: [api/prod]
`;

describe('ServiceRegistry.identify', () => {
  it('maps a granted uid to its service identity', () => {
    const registry = ServiceRegistry.fromYaml(SERVICES_YAML);

    expect(registry.identify(1002)).toEqual({
      name: 'iam',
      uid: 1002,
      namespaces: ['iam/prod', 'iam/dev'],
    });
  });

  it('returns null for a uid that appears in no grant', () => {
    const registry = ServiceRegistry.fromYaml(SERVICES_YAML);

    expect(registry.identify(1999)).toBeNull();
  });

  it('returns null for root, which is granted nothing by name', () => {
    // Root can already read every file on the host; the point is that it is not *silently*
    // treated as a service, so a root-owned process shows up as an unknown peer in the log.
    const registry = ServiceRegistry.fromYaml(SERVICES_YAML);

    expect(registry.identify(0)).toBeNull();
  });
});

describe('ServiceRegistry.mayRead', () => {
  it('allows a namespace the service was granted', () => {
    const registry = ServiceRegistry.fromYaml(SERVICES_YAML);

    expect(registry.mayRead(mustIdentify(registry, 1002), 'iam/prod')).toBe(true);
  });

  it('denies another service its neighbour namespace', () => {
    const registry = ServiceRegistry.fromYaml(SERVICES_YAML);
    expect(registry.mayRead(mustIdentify(registry, 1003), 'iam/prod')).toBe(false);
  });

  it('denies a namespace no grant mentions', () => {
    const registry = ServiceRegistry.fromYaml(SERVICES_YAML);
    expect(registry.mayRead(mustIdentify(registry, 1002), 'audit/prod')).toBe(false);
  });

  it('does not treat a namespace grant as a prefix grant', () => {
    // `api/prod` must not imply `api/prod-eu`. Substring matching here would silently widen
    // every grant in the file.
    const registry = ServiceRegistry.fromYaml(SERVICES_YAML);
    const api = mustIdentify(registry, 1003);

    expect(registry.mayRead(api, 'api/prod-eu')).toBe(false);
    expect(registry.mayRead(api, 'api')).toBe(false);
  });
});

describe('ServiceRegistry.fromYaml validation', () => {
  it('rejects a file where two services claim the same uid', () => {
    // Ambiguous identity is unresolvable at request time: SO_PEERCRED reports a uid and the
    // registry would have to pick. Fail at load, where a human is watching.
    const duplicate = `
services:
  - name: iam
    uid: 1002
    namespaces: [iam/prod]
  - name: api
    uid: 1002
    namespaces: [api/prod]
`;

    expect(() => ServiceRegistry.fromYaml(duplicate)).toThrow(/uid 1002/i);
  });

  it('rejects a service with no namespaces rather than granting it nothing quietly', () => {
    const empty = `
services:
  - name: iam
    uid: 1002
    namespaces: []
`;

    expect(() => ServiceRegistry.fromYaml(empty)).toThrow(/namespace/i);
  });

  it('rejects a malformed entry', () => {
    const malformed = `
services:
  - name: iam
    namespaces: [iam/prod]
`;

    expect(() => ServiceRegistry.fromYaml(malformed)).toThrow(/uid/i);
  });

  it('rejects a namespace that is not service/environment shaped', () => {
    const bad = `
services:
  - name: iam
    uid: 1002
    namespaces: ["../../etc/passwd"]
`;

    expect(() => ServiceRegistry.fromYaml(bad)).toThrow(/namespace/i);
  });
});
