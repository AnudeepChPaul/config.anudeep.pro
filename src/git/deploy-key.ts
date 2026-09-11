import { chmod, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logCaught, logged } from '@config/src/logging.js';

/**
 * Makes the deploy key usable by ssh.
 *
 * ssh refuses a private key that other users can read, and reports it as
 * "Permission denied (publickey)" — which reads as a rejected key rather than a local file
 * mode. The key arrives as a mount, and a mount's mode is not this service's to choose: Docker
 * Desktop presents a bind-mounted file as 0755 on macOS whatever the host file says. So the
 * service takes a 0600 copy rather than requiring an operator to win an argument with the
 * container runtime.
 *
 * Never throws. A key that is missing or unreadable must surface as a push that fails with a
 * reason on a page someone is looking at, not as a service that will not start — the registry
 * still serves everything it holds without ever reaching GitHub.
 */
export async function prepareDeployKey(
  path: string | null | undefined,
  privateDir: string,
): Promise<string | null> {
  return logged(undefined, 'config.git.deploy-key', { logger: 'git.deploy-key' }, async () => {
    if (!path) return null;

    try {
      const mode = (await stat(path)).mode & 0o777;
      // Already private: copying a key around for no reason is not an improvement.
      if ((mode & 0o077) === 0) return path;

      const target = join(privateDir, 'deploy_key');
      await copyFile(path, target);
      await chmod(target, 0o600);
      return target;
    } catch (error) {
      logCaught(error, 'config.git.deploy-key.failed', { logger: 'git.deploy-key' });
      return null;
    }
  });
}
