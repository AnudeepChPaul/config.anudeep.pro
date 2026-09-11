import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DBEngine, type WriteEvent } from '@config/src/store/data-layer.js';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('recovery after the writing process is killed', () => {
  it.each(['schema.yaml', 'config/web/dev.yaml', 'services.yaml', '.revision'])(
    'finishes the transaction after %s without advancing the revision twice',
    async (checkpoint) => {
      const root = await mkdtemp(join(tmpdir(), 'config-crash-'));
      roots.push(root);
      await expect(
        promisify(execFile)(process.execPath, [
          '--import',
          'tsx',
          '--conditions=development',
          fileURLToPath(new URL('../fixtures/transaction-crash.ts', import.meta.url)),
          root,
          checkpoint,
        ]),
      ).rejects.toMatchObject({ signal: 'SIGKILL' });
      const events: WriteEvent[] = [];
      const restarted = new DBEngine(root, {
        onWrite: (event) => {
          events.push(event);
        },
      });
      expect(await restarted.snapshot()).toEqual({
        revision: '1',
        files: new Map([
          ['schema.yaml', 'schema'],
          ['config/web/dev.yaml', 'encrypted config'],
          ['services.yaml', 'registry'],
        ]),
      });
      expect(events).toHaveLength(3);
      expect(new Set(events.map((event) => event.transactionId)).size).toBe(1);
      expect(await new DBEngine(root).revision()).toBe('1');
      expect(await readdir(join(root, '.journal', 'transactions'))).toEqual([]);
    },
  );
});
