import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** First-boot migration from the existing clone into the source-of-truth database. */
export async function bootstrapDb(dbPath: string, barePath: string): Promise<boolean> {
  await mkdir(dbPath, { recursive: true, mode: 0o700 });
  const existing = await readdir(dbPath);
  if (existing.length > 0) return false;
  for (const entry of await readdir(barePath)) {
    if (entry === '.git') continue;
    await cp(join(barePath, entry), join(dbPath, entry), {
      recursive: true,
      force: false,
      preserveTimestamps: true,
    });
  }
  return true;
}
