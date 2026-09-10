import { lstat, unlink } from 'node:fs/promises';

/** Approved cutover: remove the configured legacy work file, never follow a link or recurse. */
export async function discardLegacyWork(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error('legacy work path must be a regular file');
  await unlink(path);
  return true;
}
