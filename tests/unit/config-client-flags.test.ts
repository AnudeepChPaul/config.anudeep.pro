import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigClient } from '@config/src/client/config-client.js';
import { describe, expect, it } from 'vitest';

describe('ConfigClient flags', () => {
  it('returns explicit fallback for an unknown flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-client-test-'));
    const client = new ConfigClient({
      socketPath: join(root, 'missing.sock'),
      service: 'web',
      environment: 'prod',
    });

    await client.load({ ENABLED: false });

    expect(client.flag('NEW_CHECKOUT')).toBe(false);
    expect(client.flag('NEW_CHECKOUT', true)).toBe(true);
  });
});
