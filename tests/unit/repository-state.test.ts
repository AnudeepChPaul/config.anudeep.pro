import { RepositoryState } from '@config/src/boot/repository-state.js';
import { describe, expect, it } from 'vitest';

/**
 * What a reload refreshes, and in what order.
 *
 * The registry was read once at boot and never again, so removing a namespace from a uid in
 * services.yaml had no effect until a restart — while the reload happily made that commit's
 * VALUES live. A revocation and a secret rotation usually arrive in the same change, so the
 * rotated secret reached exactly the uid the change was taking it away from.
 */
const SERVICES = (namespaces: string) =>
  `services:\n  - name: iam\n    uid: 1002\n    namespaces: [${namespaces}]\n`;

const stateWith = (files: Record<string, string>) => {
  const current = { ...files };
  const order: string[] = [];

  const state = new RepositoryState({
    readFile: async (path) => {
      const contents = current[path];
      if (contents === undefined) throw new Error(`no ${path}`);
      return contents;
    },
    loadSchemas: async () => {
      order.push('schemas');
      return { iam: 'keys:\n  A:\n    type: string\n' };
    },
    breakGlassPath: 'break-glass.yaml',
    onRegistry: () => {
      order.push('registry');
    },
    onCache: () => {
      order.push('cache');
    },
  });

  return { state, current, order };
};

describe('RepositoryState.reload', () => {
  it('rebuilds the registry, so a revoked grant stops being granted', async () => {
    const { state, current } = stateWith({
      'services.yaml': SERVICES('iam/prod, payments/prod'),
    });
    await state.reload();
    expect(
      state.registry().mayRead({ name: 'iam', uid: 1002, namespaces: [] }, 'payments/prod'),
    ).toBe(true);

    current['services.yaml'] = SERVICES('iam/prod');
    await state.reload();

    expect(
      state.registry().mayRead({ name: 'iam', uid: 1002, namespaces: [] }, 'payments/prod'),
    ).toBe(false);
  });

  it('rebuilds the registry BEFORE the values it governs', async () => {
    // Otherwise a change that both rotates a secret and revokes a grant makes the new secret
    // readable by the uid the same change was taking it away from.
    const { state, order } = stateWith({ 'services.yaml': SERVICES('iam/prod') });

    await state.reload();

    expect(order.indexOf('registry')).toBeLessThan(order.indexOf('cache'));
  });

  it('rereads the break-glass record, so rotating it takes effect', async () => {
    const { state, current } = stateWith({
      'services.yaml': SERVICES('iam/prod'),
      'break-glass.yaml': 'passwordHash: one\ntotpSecret: AAAA\nactorEmail: ops@anudeep.pro\n',
    });
    await state.reload();
    expect(state.breakGlassRecord()?.passwordHash).toBe('one');

    current['break-glass.yaml'] =
      'passwordHash: two\ntotpSecret: BBBB\nactorEmail: ops@anudeep.pro\n';
    await state.reload();

    expect(state.breakGlassRecord()?.passwordHash).toBe('two');
  });

  it('keeps the last good registry when a reload cannot read the file', async () => {
    // Failing closed here would deny every service on a transient read error; failing open would
    // be worse. Keeping what was last known good is neither.
    const { state, current } = stateWith({ 'services.yaml': SERVICES('iam/prod') });
    await state.reload();

    delete current['services.yaml'];
    await state.reload();

    expect(state.registry().identify(1002)).not.toBeNull();
  });

  it('leaves the break-glass record absent when the file is gone', async () => {
    // A deleted record must revoke the credential, not preserve it.
    const { state, current } = stateWith({
      'services.yaml': SERVICES('iam/prod'),
      'break-glass.yaml': 'passwordHash: one\ntotpSecret: AAAA\nactorEmail: ops@anudeep.pro\n',
    });
    await state.reload();

    delete current['break-glass.yaml'];
    await state.reload();

    expect(state.breakGlassRecord()).toBeNull();
  });

  it('grants nothing until services.yaml has actually been read', () => {
    const { state } = stateWith({ 'services.yaml': SERVICES('iam/prod') });

    expect(state.registry().identify(1002)).toBeNull();
    expect(state.registry().mayRead({ name: 'iam', uid: 1002, namespaces: [] }, 'iam/prod')).toBe(
      false,
    );
  });
});
