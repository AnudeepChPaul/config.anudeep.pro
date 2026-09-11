/**
 * Structured JSON logging, correlated with the request it belongs to.
 *
 * Stdout stays JSON. Postgres is an additional sink (see db-sink). A request_sid mixin is how
 * a line found during an incident leads back to the HTTP request that caused it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { processedMessage } from '@config/src/logging/message.js';
import pino, { type Logger } from 'pino';

interface RequestContext {
  requestSid: string;
  userEmail?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function currentRequestSid(): string | undefined {
  return als.getStore()?.requestSid;
}

export function currentUserEmail(): string | undefined {
  return als.getStore()?.userEmail;
}

export function setUserEmail(email: string | undefined): void {
  const store = als.getStore();
  if (store && email) store.userEmail = email;
}

export type LogFields = Record<string, string | number | boolean | undefined>;

let rootLog: Logger | undefined;

export function getLog(): Logger | undefined {
  return rootLog;
}

export function configureLogging(
  level: string,
  jsonOutput: boolean,
  sink?: { stream(): NodeJS.WritableStream },
): Logger {
  const streams: pino.StreamEntry[] = [{ level: 'trace', stream: stdoutStream(jsonOutput) }];
  if (sink) streams.push({ level: 'trace', stream: sink.stream() });

  const logger = pino(
    {
      level,
      mixin() {
        const store = als.getStore();
        return {
          ...(store?.requestSid ? { request_sid: store.requestSid } : {}),
        };
      },
      messageKey: 'msg',
      serializers: { err: pino.stdSerializers.err },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
  rootLog = logger;
  return logger;
}

export type MethodLog = {
  debug: (fields: object, event: string) => void;
  warn: (fields: object, event: string) => void;
  error: (fields: object, event: string) => void;
};

type LogSink = Partial<MethodLog> | Logger;

function resolveLog(log?: LogSink): LogSink | undefined {
  return log ?? rootLog;
}

export function emit(
  log: LogSink | undefined,
  level: 'debug' | 'warn' | 'error',
  fields: object,
  event: string,
): void {
  const logger = resolveLog(log);
  if (!logger?.[level]) return;
  const line = lineFor(event, fields);
  logger[level]?.(line.fields, line.msg);
}

/** Log a caught error. ENOENT is expected absence and stays debug; everything else is error. */
export function logCaught(error: unknown, event: string, fields: LogFields = {}): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    emit(undefined, 'debug', { ...fields, err: error, code }, event);
    return;
  }
  emit(undefined, 'error', { ...fields, err: error, ...(code ? { code } : {}) }, event);
}

/** A refused request or invalid payload. Warn, not error: the process did what it was asked. */
export function logRefused(event: string, fields: LogFields = {}): void {
  emit(undefined, 'warn', fields, event);
}

export async function logged<T>(
  log: LogSink | undefined,
  event: string,
  fields: LogFields,
  fn: () => Promise<T>,
): Promise<T> {
  const logger = resolveLog(log);
  if (!logger) return fn();
  const start = lineFor(`${event}.start`, fields);
  logger.debug?.(start.fields, start.msg);
  const started = performance.now();
  try {
    const result = await fn();
    const failure = outcomeFailure(result);
    const duration = { duration_ms: performance.now() - started };
    const outcome = lineFor(failure ? `${event}.failed` : `${event}.ok`, {
      ...fields,
      ...duration,
      ...failure?.fields,
    });
    if (failure) logger[failure.level]?.(outcome.fields, outcome.msg);
    else logger.debug?.(outcome.fields, outcome.msg);
    return result;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    const outcome = lineFor(`${event}.failed`, {
      ...fields,
      duration_ms: performance.now() - started,
      err: error,
    });
    if (typeof status === 'number' && status < 500) logger.warn?.(outcome.fields, outcome.msg);
    else logger.error?.(outcome.fields, outcome.msg);
    throw error;
  }
}

function outcomeFailure(
  result: unknown,
): { level: 'warn' | 'error'; fields: LogFields } | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as Record<string, unknown>;
  if (value.ok === false) {
    const fields = flattenFailure(value.error);
    return { level: fields.code === 'failed' ? 'error' : 'warn', fields };
  }
  if (value.kind === 'invalid' || value.kind === 'conflict' || value.kind === 'deferred') {
    return {
      level: 'warn',
      fields: {
        kind: String(value.kind),
        ...(typeof value.path === 'string' ? { path: value.path } : {}),
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        ...flattenProblems(value.errors),
      },
    };
  }
  if (value.pushed === false) {
    return {
      level: 'warn',
      fields: {
        pushed: false,
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      },
    };
  }
  return undefined;
}

function flattenFailure(error: unknown): LogFields {
  if (Array.isArray(error)) return flattenProblems(error);
  if (!error || typeof error !== 'object') return { detail: String(error) };
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...flattenProblems(value.errors),
  };
}

function lineFor(event: string, fields: object): { fields: object; msg: string } {
  const record = fields as Record<string, unknown>;
  const err = record.err;
  let msg = processedMessage(event, record);
  if (err instanceof Error && err.message && !msg.includes(err.message)) {
    msg = `${msg}: ${err.message}`;
  }
  return { fields: { event, ...record }, msg };
}

function flattenProblems(errors: unknown): LogFields {
  if (!Array.isArray(errors) || errors.length === 0) return {};
  const keys: string[] = [];
  const messages: string[] = [];
  for (const entry of errors) {
    if (!entry || typeof entry !== 'object') {
      messages.push(String(entry));
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.key === 'string' && item.key) keys.push(item.key);
    if (typeof item.message === 'string' && item.message) messages.push(item.message);
  }
  return {
    ...(keys.length ? { error_keys: keys.join(',') } : {}),
    ...(messages.length ? { error_messages: messages.join('; ') } : {}),
  };
}

function stdoutStream(jsonOutput: boolean): NodeJS.WritableStream {
  if (jsonOutput || !prettyAvailable()) return process.stdout;
  const require = createRequire(import.meta.url);
  const pretty = require('pino-pretty') as (options: unknown) => NodeJS.WritableStream;
  return pretty({ colorize: true });
}

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}
