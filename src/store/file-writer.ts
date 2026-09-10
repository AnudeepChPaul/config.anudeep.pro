import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Result } from '@config/src/identity/types.js';

export interface FileValidator<T, E> {
  validateFile(source: string): Result<T, E>;
}

/** The narrow filesystem mutation boundary used by the data engine. */
export class FileWriter {
  async validateFile<T, E>(path: string, validator: FileValidator<T, E>): Promise<Result<T, E>> {
    return validator.validateFile(await readFile(path, 'utf8'));
  }

  async write(path: string, content: string): Promise<void> {
    await this.ensureDirectory(dirname(path));
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await this.syncDirectory(dirname(path));
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => {});
      throw cause;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
    await this.syncDirectory(dirname(path));
  }

  /** Staged contents are already durable; publication preserves caller-specified ordering. */
  async install(staged: string, target: string): Promise<void> {
    await this.ensureDirectory(dirname(target));
    await rename(staged, target);
    await this.syncDirectory(dirname(target));
    await this.syncDirectory(dirname(staged));
  }

  async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
    if (!firstCreated) return;
    // Persist each newly created directory's link, including its link in the existing parent.
    const stop = dirname(firstCreated);
    let parent = path;
    while (true) {
      await this.syncDirectory(parent);
      if (parent === stop) return;
      parent = dirname(parent);
    }
  }
}
