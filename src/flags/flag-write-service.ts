import type { FlagValidationError, FlagValidator } from '@config/src/flags/flag-document.js';
import type { DBEngine, WriteResult } from '@config/src/store/data-layer.js';
import { parse, stringify } from 'yaml';

export type FlagWriteResult =
  | { readonly kind: 'written'; readonly revision: string; readonly etag: string }
  | { readonly kind: 'unchanged'; readonly revision: string; readonly etag: string }
  | { readonly kind: 'conflict'; readonly currentEtag: string; readonly revision: string }
  | { readonly kind: 'invalid'; readonly errors: readonly FlagValidationError[] };

/** Immediate flag mutations. There is deliberately no draft or Git dependency here. */
export class FlagWriteService {
  constructor(
    private readonly db: DBEngine,
    private readonly validator: FlagValidator,
    private readonly onWrite?: () => void,
  ) {}

  async get(name: string, environment: string): Promise<boolean> {
    const document = await this.readDocument();
    return document[name]?.[environment] === true;
  }

  async all(): Promise<Readonly<Record<string, Readonly<Record<string, boolean>>>>> {
    return this.readDocument();
  }

  async set(
    name: string,
    environment: string,
    value: boolean,
    expectedEtag?: string,
    actor?: string,
  ): Promise<FlagWriteResult> {
    const current = await this.db.read('flags.yaml');
    const parsed = current ? parse(current) : { version: 1, flags: {} };
    const document =
      isRecord(parsed) && isRecord(parsed.flags) ? parsed : { version: 1, flags: {} };
    const flags = document.flags as Record<string, unknown>;
    const values = isRecord(flags[name]) ? { ...(flags[name] as Record<string, unknown>) } : {};
    values[environment] = value;
    flags[name] = values;
    const content = stringify(document);
    const validation = this.validator.validateFile(content);
    if (!validation.ok) return { kind: 'invalid', errors: validation.error };

    const result = await this.db.write({
      path: 'flags.yaml',
      content,
      expectedEtag,
      actor,
      keys: [name],
      validate: (source) => {
        const checked = this.validator.validateFile(source);
        return checked.ok ? [] : checked.error;
      },
    });
    const output = toResult(result);
    if (output.kind === 'written') this.onWrite?.();
    return output;
  }

  private async readDocument(): Promise<Record<string, Record<string, boolean>>> {
    const source = await this.db.read('flags.yaml');
    if (!source) return {};
    const checked = this.validator.validateFile(source);
    if (!checked.ok) return {};
    const output: Record<string, Record<string, boolean>> = {};
    for (const [name, values] of checked.value.flags) output[name] = Object.fromEntries(values);
    return output;
  }
}

const toResult = (result: WriteResult): FlagWriteResult => {
  switch (result.kind) {
    case 'written':
      return result;
    case 'unchanged':
      return result;
    case 'conflict':
      return { kind: 'conflict', currentEtag: result.actual ?? '', revision: result.revision };
    case 'invalid':
      return { kind: 'invalid', errors: result.errors };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
