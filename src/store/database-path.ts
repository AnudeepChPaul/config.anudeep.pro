import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { logCaught } from '@config/src/logging.js';

export function databasePath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    normalize(path) !== path ||
    path.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.'))
  ) {
    throw new Error(`invalid database path: ${path}`);
  }
  return join(root, path);
}

/** Lexical confinement alone does not stop an existing directory symlink escaping the DB. */
export async function assertNoSymlinks(root: string, path: string): Promise<void> {
  databasePath(root, path);
  let candidate = root;
  for (const part of ['', ...path.split('/')]) {
    candidate = join(candidate, part);
    try {
      if ((await lstat(candidate)).isSymbolicLink())
        throw new Error(`symlink in database path: ${path}`);
    } catch (error) {
      logCaught(error, 'config.db.path.lstat.failed', { logger: 'store.database-path' });
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
