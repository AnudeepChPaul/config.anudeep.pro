import { createRequire } from 'node:module';
import pino, { type Logger } from 'pino';

const require = createRequire(import.meta.url);

const prettyStream = (): NodeJS.WritableStream => {
  try {
    const pretty = require('pino-pretty') as (options: unknown) => NodeJS.WritableStream;
    return pretty({
      colorize: true,
      colorizeObjects: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      destination: process.stderr,
    });
  } catch {
    return process.stderr;
  }
};

/** A colourised logger for package.json / scripts. Not the service JSON log. */
export function scriptLog(name: string): Logger {
  return pino(
    {
      name,
      level: 'debug',
      serializers: { err: pino.stdSerializers.err },
    },
    prettyStream(),
  );
}
