import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDeployKey } from '@config/src/git/deploy-key.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * ssh refuses a private key other users can read, and says so in a way that reads as an
 * authentication failure: "Permission denied (publickey)".
 *
 * The key arrives as a mount, and a mount's mode is not the service's to choose — Docker
 * Desktop presents a bind-mounted file as 0755 on macOS whatever the host file says. So the
 * service takes a private copy rather than requiring the operator to win an argument with the
 * container runtime.
 */
const dirs: string[] = [];
const newDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'config-key-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  dirs.splice(0);
});

const keyAt = async (mode: number) => {
  const path = join(await newDir(), 'deploy_key');
  await writeFile(path, 'PRIVATE KEY\n', { mode: 0o600 });
  await chmod(path, mode);
  return path;
};

describe('prepareDeployKey', () => {
  it('copies a world-readable key to a private one', async () => {
    const source = await keyAt(0o755);

    const usable = (await prepareDeployKey(source, await newDir())) ?? '';

    expect(usable).not.toBe(source);
    expect((await stat(usable)).mode & 0o777).toBe(0o600);
    expect(await readFile(usable, 'utf8')).toBe('PRIVATE KEY\n');
  });

  it('leaves an already-private key where it is', async () => {
    // Nothing to fix, and copying a key around is not something to do for no reason.
    const source = await keyAt(0o600);

    expect(await prepareDeployKey(source, await newDir())).toBe(source);
  });

  it('returns null for a path that does not exist, rather than throwing at boot', async () => {
    // A misconfigured deploy key must surface as a push that fails with a reason, not as a
    // service that will not start.
    expect(await prepareDeployKey(join(await newDir(), 'nope'), await newDir())).toBeNull();
  });

  it('returns null when given nothing, which is the local-only case', async () => {
    expect(await prepareDeployKey(null, await newDir())).toBeNull();
  });

  it('overwrites a stale copy from a previous boot', async () => {
    const target = await newDir();
    await writeFile(join(target, 'deploy_key'), 'OLD\n', { mode: 0o600 });

    const usable = await prepareDeployKey(await keyAt(0o755), target);

    expect(await readFile(usable ?? '', 'utf8')).toBe('PRIVATE KEY\n');
  });
});
