import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardLegacyWork } from '@config/src/boot/discard-legacy-work.js';
import { expect, it } from 'vitest';

it('discards only the configured regular file and refuses symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cutover-'));
  try {
    const path = join(root, 'drafts.json');
    await writeFile(path, 'old work');
    expect(await discardLegacyWork(path)).toBe(true);
    expect(await discardLegacyWork(path)).toBe(false);
    const retained = join(root, 'data.yaml');
    await writeFile(retained, 'live');
    await symlink(retained, path);
    await expect(discardLegacyWork(path)).rejects.toThrow(/regular file/);
    expect(await readFile(retained, 'utf8')).toBe('live');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
