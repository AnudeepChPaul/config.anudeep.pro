import { scriptLog } from '@config/src/cli/script-log.js';

const [script, ...detail] = process.argv.slice(2);
scriptLog('pnpm').info(
  { detail: detail.length ? detail.join(' ') : undefined, cwd: process.cwd() },
  script ?? 'script',
);
