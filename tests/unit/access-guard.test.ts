import type { Socket } from 'node:net';
import { AccessGuard } from '@config/src/identity/access-guard.js';
import { PeerCredentialResolver } from '@config/src/identity/peercred.js';
import { ServiceRegistry } from '@config/src/identity/registry.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one decision point. Every read of every namespace passes through `authorize`, so the
 * properties asserted here are the security properties of the service:
 *
 *  - a denial is generic to the caller and specific in the audit log
 *  - the first denial of a kind raises an alert; the flood after it does not
 *  - a broken mechanism denies, it does not fall open
 */

const SERVICES_YAML = `
services:
  - name: iam
    uid: 1002
    namespaces: [iam/prod]
  - name: api
    uid: 1003
    namespaces: [api/prod]
`;

const socket = () => ({ destroyed: false }) as unknown as Socket;

const guardFor = (uid: number) => {
  const audit = vi.fn();
  const alert = vi.fn();
  const guard = new AccessGuard({
    resolver: new PeerCredentialResolver(() => ({ uid, gid: uid, pid: 4711 })),
    registry: () => ServiceRegistry.fromYaml(SERVICES_YAML),
    audit,
    alert,
  });
  return { guard, audit, alert };
};

describe('AccessGuard.authorize', () => {
  it('allows a known service reading a namespace it was granted', () => {
    const { guard } = guardFor(1002);

    const result = guard.authorize(socket(), 'iam/prod');

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.name).toBe('iam');
  });

  it('denies a known service reading another service namespace', () => {
    const { guard } = guardFor(1003);

    const result = guard.authorize(socket(), 'iam/prod');

    expect(result.ok).toBe(false);
  });

  it('denies a uid that is in no grant', () => {
    const { guard } = guardFor(1999);

    expect(guard.authorize(socket(), 'iam/prod').ok).toBe(false);
  });

  it('denies when the credential cannot be read at all', () => {
    // Fail closed. A resolver error means the mechanism is not working, which is strictly worse
    // than an unknown caller and must never be the path that grants access.
    const guard = new AccessGuard({
      resolver: new PeerCredentialResolver(() => {
        throw new Error('ENOTSOCK');
      }),
      registry: () => ServiceRegistry.fromYaml(SERVICES_YAML),
      audit: vi.fn(),
      alert: vi.fn(),
    });

    expect(guard.authorize(socket(), 'iam/prod').ok).toBe(false);
  });
});

describe('AccessGuard denial disclosure', () => {
  it('tells the caller nothing about why it was denied', () => {
    // An unknown uid and a wrong namespace must be indistinguishable from outside, or the
    // endpoint becomes an oracle for which namespaces and uids exist.
    const unknownUid = guardFor(1999).guard.authorize(socket(), 'iam/prod');
    const wrongNamespace = guardFor(1003).guard.authorize(socket(), 'iam/prod');

    expect(unknownUid.ok).toBe(false);
    expect(wrongNamespace.ok).toBe(false);
    expect(!unknownUid.ok && unknownUid.error).toEqual(!wrongNamespace.ok && wrongNamespace.error);
    expect(!unknownUid.ok && unknownUid.error.status).toBe(403);
    expect(!unknownUid.ok && unknownUid.error.detail).not.toMatch(/1999|uid|namespace/i);
  });
});

describe('AccessGuard auditing and alerting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records every denial with the facts the log needs', () => {
    const { guard, audit } = guardFor(1003);

    guard.authorize(socket(), 'iam/prod');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        uid: 1003,
        service: 'api',
        namespace: 'iam/prod',
        reason: 'namespace_not_granted',
      }),
    );
  });

  it('distinguishes an unknown uid from a wrong namespace in the log', () => {
    const { guard, audit } = guardFor(1999);

    guard.authorize(socket(), 'iam/prod');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'denied',
        uid: 1999,
        service: null,
        reason: 'unknown_uid',
      }),
    );
  });

  it('records allowed reads too, so the log answers "who read this key"', () => {
    const { guard, audit } = guardFor(1002);

    guard.authorize(socket(), 'iam/prod');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'allowed',
        uid: 1002,
        service: 'iam',
        namespace: 'iam/prod',
      }),
    );
  });

  it('alerts on the first occurrence of a denial and not on the repeats', () => {
    // The endpoint is unreachable from the internet, so a denial means something on the host is
    // misconfigured or compromised — worth waking someone once. A retry loop must not page
    // continuously for the same fact.
    const { guard, alert } = guardFor(1003);

    guard.authorize(socket(), 'iam/prod');
    guard.authorize(socket(), 'iam/prod');
    guard.authorize(socket(), 'iam/prod');

    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('alerts again for a different denial', () => {
    const { guard, alert } = guardFor(1003);

    guard.authorize(socket(), 'iam/prod');
    guard.authorize(socket(), 'audit/prod');

    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('never alerts on an allowed read', () => {
    const { guard, alert } = guardFor(1002);

    guard.authorize(socket(), 'iam/prod');

    expect(alert).not.toHaveBeenCalled();
  });
});
