import { EnvironmentOrder } from '@config/src/store/environment-order.js';
import { describe, expect, it } from 'vitest';

/**
 * Which environment comes after which.
 *
 * Nothing in a namespace name says dev precedes prod, and guessing it wrong promotes production
 * into development. So the order is declared in the repository — `environments.yaml` — and when
 * it is absent nothing is offered at all.
 */

const ORDER = 'order: [dev, staging, prod]\n';

describe('EnvironmentOrder', () => {
  it('names the environment after this one', () => {
    const order = EnvironmentOrder.fromYaml(ORDER);

    expect(order.next('dev')).toBe('staging');
    expect(order.next('staging')).toBe('prod');
  });

  it('has nothing after the last one', () => {
    expect(EnvironmentOrder.fromYaml(ORDER).next('prod')).toBeNull();
  });

  it('has nothing for an environment it does not list', () => {
    // A namespace nobody put in the order is not promotable; offering a guess would be worse
    // than offering nothing.
    expect(EnvironmentOrder.fromYaml(ORDER).next('sandbox')).toBeNull();
  });

  it('offers nothing at all when the file is missing', () => {
    // The failure that matters: with no declared order, promotion must be unavailable rather
    // than inferred from names.
    expect(EnvironmentOrder.none().next('dev')).toBeNull();
  });

  it('offers nothing when the file is malformed', () => {
    expect(EnvironmentOrder.fromYaml('order: not-a-list\n').next('dev')).toBeNull();
    expect(EnvironmentOrder.fromYaml('nonsense: [').next('dev')).toBeNull();
  });

  it('ignores entries that are not environment names', () => {
    expect(EnvironmentOrder.fromYaml('order: [dev, 7, prod]\n').next('dev')).toBe('prod');
  });
});

/**
 * The declared list is also what the console renders as tabs: every environment in the file, for
 * every product, and nothing that is not in it.
 */
describe('the declared list', () => {
  it('is every environment, in the order it was declared', () => {
    expect(EnvironmentOrder.fromYaml('order: [dev, staging, prod]\n').all()).toEqual([
      'dev',
      'staging',
      'prod',
    ]);
  });

  it('is empty when nothing is declared, so the console renders no tabs it was not told about', () => {
    expect(EnvironmentOrder.none().all()).toEqual([]);
    expect(EnvironmentOrder.fromYaml('nonsense').all()).toEqual([]);
  });
});
