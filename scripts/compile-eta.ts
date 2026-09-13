import { scriptLog } from '@config/src/cli/script-log.js';
import { main } from '@config/src/views/compile-eta.js';

const argv = process.argv.slice(2);
const log = scriptLog('compile-eta');
log.info({ pid: process.pid, cwd: process.cwd(), argv }, 'start');

try {
  await main(argv);
  log.info('finished ok');
} catch (error) {
  log.error({ err: error }, 'failed');
  process.exit(1);
}
