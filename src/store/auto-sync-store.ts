import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logCaught, logged } from '@config/src/logging.js';

/** Operator preference for unattended git backup. Missing file is off. */
export class AutoSyncStore {
  constructor(private readonly root: string) {}

  async read(): Promise<boolean> {
    return logged(undefined, 'config.auto-sync.read', { logger: 'store.auto-sync' }, async () => {
      const source = await readFile(join(this.root, 'auto-sync.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          logCaught(error, 'config.auto-sync.read.failed', { logger: 'store.auto-sync' });
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      if (source.length === 0) return false;
      try {
        const parsed = JSON.parse(source) as { autoSync?: unknown };
        return parsed.autoSync === true;
      } catch (error) {
        logCaught(error, 'config.auto-sync.parse.failed', { logger: 'store.auto-sync' });
        return false;
      }
    });
  }

  async write(enabled: boolean): Promise<void> {
    return logged(undefined, 'config.auto-sync.write', { logger: 'store.auto-sync' }, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFile(
        join(this.root, 'auto-sync.json'),
        `${JSON.stringify({ autoSync: enabled })}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
        },
      );
    });
  }
}
