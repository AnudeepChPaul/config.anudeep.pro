import { lstat, unlink } from 'node:fs/promises';
import { logCaught } from '@config/src/logging.js';

/** Approved cutover: remove the configured legacy work file, never follow a link or recurse. */
export async function discardLegacyWork(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    logCaught(error, 'config.boot.legacy.lstat.failed', { logger: 'boot.discard-legacy' });
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error('legacy work path must be a regular file');
  await unlink(path);
  return true;
}
