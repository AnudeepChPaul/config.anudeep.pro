import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoSymlinks, databasePath } from '@config/src/store/database-path.js';
import type { FileWriter } from '@config/src/store/file-writer.js';
import { z } from 'zod';

const mutation = z.object({
  path: z.string(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  actor: z.string().optional(),
  keys: z.array(z.string()),
});
const intentSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  files: z.array(mutation).min(1),
});
export type TransactionIntent = z.infer<typeof intentSchema>;
export interface PreparedTransaction {
  readonly id: string;
  readonly files: TransactionIntent['files'];
}
export const contentHash = (source: string): string =>
  createHash('sha256').update(source).digest('hex');
export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Private redo journal. It stores staged ciphertext, never decrypted namespace documents. */
export class TransactionJournal {
  private readonly directory: string;
  constructor(
    private readonly root: string,
    private readonly writer: FileWriter,
  ) {
    this.directory = join(root, '.journal', 'transactions');
  }

  async prepare(
    files: readonly {
      path: string;
      content: string | null;
      actor?: string;
      keys?: readonly string[];
    }[],
  ): Promise<PreparedTransaction> {
    const id = randomUUID();
    await mkdir(join(this.directory, id), { recursive: true, mode: 0o700 });
    await this.writer.syncDirectory(this.root);
    await this.writer.syncDirectory(join(this.root, '.journal'));
    await this.writer.syncDirectory(this.directory);
    try {
      for (const [index, file] of files.entries()) {
        if (file.content !== null) await this.writer.write(this.staged(id, index), file.content);
      }
      return {
        id,
        files: files.map((file) => ({
          path: file.path,
          hash: file.content === null ? null : contentHash(file.content),
          ...(file.actor ? { actor: file.actor } : {}),
          keys: [...(file.keys ?? [])],
        })),
      };
    } catch (error) {
      await this.complete(id);
      throw error;
    }
  }

  async recordIntent(
    transaction: PreparedTransaction,
    revision: number,
  ): Promise<TransactionIntent> {
    const intent = intentSchema.parse({ version: 1, revision, files: transaction.files });
    await this.writer.write(
      join(this.directory, transaction.id, 'intent.json'),
      JSON.stringify(intent),
    );
    return intent;
  }

  /** Check every remaining payload before resuming any rename. Missing/corrupt data fails closed. */
  async apply(id: string, intent: TransactionIntent): Promise<void> {
    for (const [index, file] of intent.files.entries()) {
      await assertNoSymlinks(this.root, file.path);
      if (file.hash === null) continue;
      const target = await readOptional(databasePath(this.root, file.path));
      if (target !== null && contentHash(target) === file.hash) continue;
      const staged = await readOptional(this.staged(id, index));
      if (staged === null || contentHash(staged) !== file.hash)
        throw new Error(`cannot recover transaction ${id}: payload ${index} is missing or corrupt`);
    }
    for (const [index, file] of intent.files.entries()) {
      const path = databasePath(this.root, file.path);
      const current = await readOptional(path);
      if (file.hash === null) {
        if (current !== null) await this.writer.remove(path);
      } else if (current === null || contentHash(current) !== file.hash) {
        await this.writer.install(this.staged(id, index), path);
      }
    }
  }

  async pending(): Promise<Array<{ id: string; intent: TransactionIntent }>> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const pending: Array<{ id: string; intent: TransactionIntent }> = [];
    for (const id of entries) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('unrecognized transaction directory');
      const source = await readOptional(join(this.directory, id, 'intent.json'));
      if (source === null) {
        await this.complete(id);
        continue;
      }
      const intent = intentSchema.parse(JSON.parse(source));
      for (const file of intent.files) databasePath(this.root, file.path);
      pending.push({ id, intent });
    }
    return pending.sort((a, b) => a.intent.revision - b.intent.revision);
  }

  async complete(id: string): Promise<void> {
    await rm(join(this.directory, id), { recursive: true, force: true });
    await this.writer.syncDirectory(this.directory);
  }

  private staged(id: string, index: number): string {
    return join(this.directory, id, `${index}.stage`);
  }
}
