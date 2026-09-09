import { breakGlassReader } from '@config/src/boot/break-glass-source.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * Where the break-glass record is read from.
 *
 * It used to live in the repository, committed as `break-glass.yaml`. Nothing excluded it from
 * a push, so on a repository with a remote the first publish sent the credential to GitHub —
 * the incident that forced a history rewrite once already. A record held outside the tree
 * cannot be pushed, because there is nothing to commit.
 *
 * The relative form stays, so an existing volume whose record is only in the repository still
 * boots and can still revoke it.
 */
describe('reading the break-glass record', () => {
  const fromRepository = vi.fn(async () => 'in the repository');
  const fromFilesystem = vi.fn(async () => 'on the volume');
  const reader = () => breakGlassReader({ fromRepository, fromFilesystem });

  it('reads an absolute path from the filesystem, never from the repository', async () => {
    fromRepository.mockClear();
    await expect(reader()('/var/lib/config/break-glass.yaml')).resolves.toBe('on the volume');
    expect(fromRepository).not.toHaveBeenCalled();
  });

  it('reads a relative path through the repository, as before', async () => {
    fromFilesystem.mockClear();
    await expect(reader()('break-glass.yaml')).resolves.toBe('in the repository');
    expect(fromFilesystem).not.toHaveBeenCalled();
  });

  // Deleting the file is how the credential is revoked. That has to work whichever side it is
  // on, so the failure must propagate rather than be swallowed into an empty record.
  it('lets a missing file fail, so a deletion still revokes', async () => {
    const gone = breakGlassReader({
      fromRepository,
      fromFilesystem: async () => {
        throw new Error('ENOENT');
      },
    });
    await expect(gone('/var/lib/config/break-glass.yaml')).rejects.toThrow('ENOENT');
  });

  it('routes every other repository read the same way it always did', async () => {
    await expect(reader()('services.yaml')).resolves.toBe('in the repository');
  });
});
