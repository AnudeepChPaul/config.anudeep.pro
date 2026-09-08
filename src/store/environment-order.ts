import { parse as parseYaml } from 'yaml';

/**
 * Which environment promotes into which.
 *
 * Nothing in `iam/dev` says it comes before `iam/prod`, and a wrong guess promotes production
 * into development — the worst possible failure for the feature. So the order is declared in the
 * repository, in `environments.yaml`:
 *
 *     order: [dev, staging, prod]
 *
 * With no such file, promotion is simply not offered. An absent declaration means nobody has
 * said what the order is, which is different from it being obvious.
 */
export class EnvironmentOrder {
  private constructor(private readonly order: readonly string[]) {}

  static none(): EnvironmentOrder {
    return new EnvironmentOrder([]);
  }

  static fromYaml(source: string): EnvironmentOrder {
    let parsed: unknown;
    try {
      parsed = parseYaml(source);
    } catch {
      return EnvironmentOrder.none();
    }

    const order = (parsed as { order?: unknown } | null)?.order;
    if (!Array.isArray(order)) return EnvironmentOrder.none();

    return new EnvironmentOrder(
      order.filter((entry): entry is string => typeof entry === 'string'),
    );
  }

  /**
   * Every declared environment, in order.
   *
   * The console renders exactly these as tabs — for every product, whether or not it holds a
   * file for one yet. An environment nobody declared is not rendered, and a namespace in the
   * tree whose environment is absent from here is not either.
   */
  all(): readonly string[] {
    return this.order;
  }

  /** The environment after this one, or null when there is none or it is not listed. */
  next(environment: string): string | null {
    const index = this.order.indexOf(environment);
    if (index === -1) return null;
    return this.order[index + 1] ?? null;
  }
}
