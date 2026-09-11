import { join } from 'node:path';
import { DBEngine } from '@config/src/store/data-layer.js';
import { FileWriter } from '@config/src/store/file-writer.js';

const root = process.argv[2] ?? '';
const checkpoint = process.argv[3] ?? '';
if (!root || !checkpoint) throw new Error('root and checkpoint are required');
class CrashWriter extends FileWriter {
  override async install(staged: string, target: string) {
    await super.install(staged, target);
    if (target === join(root, checkpoint)) process.kill(process.pid, 'SIGKILL');
  }
  override async write(path: string, content: string) {
    await super.write(path, content);
    if (checkpoint === '.revision' && path === join(root, '.revision'))
      process.kill(process.pid, 'SIGKILL');
  }
}
await new DBEngine(root, { writer: new CrashWriter() }).writeMany([
  { path: 'schema.yaml', content: 'schema', actor: 'operator', keys: ['web'] },
  { path: 'config/web/dev.yaml', content: 'encrypted config', actor: 'operator', keys: ['KEY'] },
  { path: 'services.yaml', content: 'registry', actor: 'operator', keys: ['web'] },
]);
