import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlagValidator } from '@config/src/flags/flag-document.js';
import { FlagWriteService } from '@config/src/flags/flag-write-service.js';
import { DBEngine } from '@config/src/store/data-layer.js';
import { describe, expect, it } from 'vitest';

const environments = { has: (name: string) => ['dev', 'staging', 'prod'].includes(name) };

describe('FlagWriteService', () => {
  it('writes an immediate validated flag change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-flag-write-'));
    const service = new FlagWriteService(new DBEngine(root), new FlagValidator(environments));

    const result = await service.set('NewCheckout', 'prod', true);

    expect(result.kind).toBe('written');
    expect(await service.get('NewCheckout', 'prod')).toBe(true);
  });

  it('rejects an unknown environment without changing the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-flag-write-'));
    const engine = new DBEngine(root);
    const service = new FlagWriteService(engine, new FlagValidator(environments));

    const result = await service.set('NewCheckout', 'qa', true);

    expect(result.kind).toBe('invalid');
    expect(await engine.read('flags.yaml')).toBeNull();
  });
});
