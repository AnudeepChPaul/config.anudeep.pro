/**
 * Writes log lines into `log.app_log` and `log.access_log`.
 *
 * Fail-open: lines buffer, flush on a timer, and a down database never fails the operator
 * request. Secrets and PII are redacted before INSERT. See sql/log/0001_log_schema.sql.
 */
import { hostname } from 'node:os';
import { Writable } from 'node:stream';
import { processedMessage } from '@config/src/logging/message.js';
import { logCaught } from '@config/src/logging.js';
import pg from 'pg';

const BATCH_ROWS = 100;
const FLUSH_MS = 250;
const MAX_BUFFERED = 5_000;
const REDACTED = '__redacted__';

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const HOSTNAME = hostname();

const SECRET_KEYS = [
  'password',
  'token',
  'secret',
  'handle',
  'totp',
  'csrf',
  'authorization',
  'cookie',
  'age',
  'sops',
];
const PII_KEYS = ['email', 'ip', 'fingerprint', 'phone', 'address'];

const RESERVED = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'event',
  'msg',
  'message',
  'trace_id',
  'span_id',
  'request_id',
  'request_sid',
  'user_email',
  'err',
  'logger',
  'access',
]);

function errOf(
  line: Record<string, unknown>,
): { type?: string; message?: string; stack?: string } | undefined {
  const err = line.err;
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  if (!err || typeof err !== 'object') return undefined;
  const value = err as Record<string, unknown>;
  return {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
  };
}

function redact(attributes: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const lowered = key.toLowerCase();
    const sensitive =
      SECRET_KEYS.some((hint) => lowered.includes(hint)) ||
      PII_KEYS.some((hint) => lowered === hint || lowered.endsWith(`_${hint}`));
    safe[key] = sensitive ? REDACTED : value;
  }
  return safe;
}

function messageOf(
  line: Record<string, unknown>,
  err: { type?: string; message?: string; stack?: string } | undefined,
): string {
  const event = String(line.event ?? '');
  const msg =
    (typeof line.msg === 'string' && line.msg) ||
    (typeof line.message === 'string' && line.message) ||
    processedMessage(event, line);
  const level = Number(line.level ?? 30);
  if (level >= 50 && err?.stack) return `${msg}\n${err.stack}`;
  if (err?.message && !msg.includes(err.message)) return `${msg}: ${err.message}`;
  return msg;
}

function multiValues(rows: unknown[][]): { placeholders: string; values: unknown[] } {
  const values: unknown[] = [];
  const chunks = rows.map((row) => {
    const marks = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${marks.join(',')})`;
  });
  return { placeholders: chunks.join(','), values };
}

export interface AppLogRow {
  occurredAt: Date;
  level: number;
  message: string;
  logger?: string;
  errorType?: string;
  errorStack?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  requestSid?: string;
  pid?: number;
  attributes: Record<string, unknown>;
}

export interface AccessLogRow {
  occurredAt: Date;
  method: string;
  route?: string;
  path: string;
  statusCode: number;
  durationMs: number;
  responseBytes?: number;
  sourceIp?: string;
  userAgent?: string;
  userId?: string;
  userEmail?: string;
  serviceId?: string;
  traceId?: string;
  requestId: string;
}

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
}

export interface DbSinkOptions {
  databaseUrl: string;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  onError?: (error: Error) => void;
  /** Tests inject a fake. Production constructs a pg.Pool from databaseUrl. */
  pool?: Queryable;
}

export function createLogSink(config: {
  logDatabaseUrl: string | null;
  environment: string;
  serviceVersion?: string;
  onError?: (error: Error) => void;
}): LogDbSink | undefined {
  if (!config.logDatabaseUrl) return undefined;
  return new LogDbSink({
    databaseUrl: config.logDatabaseUrl,
    serviceName: 'config.anudeep.pro',
    serviceVersion: config.serviceVersion ?? '0.0.0',
    environment: config.environment,
    onError: config.onError,
  });
}

export class LogDbSink {
  private readonly pool: Queryable;
  private readonly options: DbSinkOptions;
  private appRows: AppLogRow[] = [];
  private accessRows: AccessLogRow[] = [];
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  dropped = 0;

  constructor(options: DbSinkOptions) {
    this.options = options;
    this.pool =
      options.pool ??
      new pg.Pool({
        connectionString: options.databaseUrl,
        max: 2,
        connectionTimeoutMillis: 2_000,
        allowExitOnIdle: true,
      });
    this.pool.on('error', (error) => this.options.onError?.(error));
  }

  peekApp(): readonly AppLogRow[] {
    return this.appRows;
  }

  peekAccess(): readonly AccessLogRow[] {
    return this.accessRows;
  }

  stream(): Writable {
    return new Writable({
      write: (chunk, _encoding, done) => {
        try {
          this.accept(JSON.parse(String(chunk)));
        } catch (error) {
          this.dropped += 1;
          process.stderr.write(`log sink dropped a malformed line: ${(error as Error).message}\n`);
        }
        done();
      },
    });
  }

  private accept(line: Record<string, unknown>): void {
    if (line.access !== undefined) {
      this.pushAccess(line.access as AccessLogRow);
      return;
    }
    const err = errOf(line);
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(line)) {
      if (!RESERVED.has(key)) attributes[key] = value;
    }
    const sid = String(line.request_sid ?? line.request_id ?? '') || undefined;
    const level = Number(line.level ?? 30);

    this.push('app', {
      occurredAt: line.time ? new Date(String(line.time)) : new Date(),
      level,
      message: messageOf(line, err),
      logger: line.logger as string | undefined,
      errorType: err?.type,
      errorStack: level >= 50 ? err?.stack : undefined,
      traceId: line.trace_id as string | undefined,
      spanId: line.span_id as string | undefined,
      requestId: sid,
      requestSid: sid,
      pid: line.pid as number | undefined,
      attributes: redact(attributes),
    });
  }

  pushAccess(row: AccessLogRow): void {
    this.push('access', row);
  }

  private push(kind: 'app' | 'access', row: AppLogRow | AccessLogRow): void {
    if (this.closed) return;
    const target = kind === 'app' ? this.appRows : this.accessRows;
    if (target.length >= MAX_BUFFERED) {
      target.shift();
      this.dropped += 1;
    }
    (target as unknown[]).push(row);

    if (target.length >= BATCH_ROWS) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS).unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const app = this.appRows;
    const access = this.accessRows;
    this.appRows = [];
    this.accessRows = [];
    if (app.length === 0 && access.length === 0) return;

    try {
      if (app.length > 0) await this.insertApp(app);
      if (access.length > 0) await this.insertAccess(access);
    } catch (error) {
      this.dropped += app.length + access.length;
      process.stderr.write(`log sink flush failed: ${(error as Error).message}\n`);
      this.options.onError?.(error as Error);
    }
  }

  private async insertApp(rows: AppLogRow[]): Promise<void> {
    const { placeholders, values } = multiValues(
      rows.map((r) => [
        r.occurredAt,
        this.options.serviceName,
        this.options.serviceVersion,
        this.options.environment,
        r.pid ?? null,
        r.level,
        LEVEL_NAMES[r.level] ?? String(r.level),
        r.message,
        r.logger ?? null,
        r.errorType ?? null,
        r.errorStack ?? null,
        r.traceId ?? null,
        r.spanId ?? null,
        r.requestId ?? null,
        r.requestSid ?? r.requestId ?? null,
        JSON.stringify(r.attributes),
      ]),
    );
    await this.pool.query(
      `INSERT INTO log.app_log
         (occurred_at, service_name, service_version, environment, pid,
          level, level_name, message, logger, error_type, error_stack,
          trace_id, span_id, request_id, request_sid, attributes)
       VALUES ${placeholders}`,
      values,
    );
  }

  private async insertAccess(rows: AccessLogRow[]): Promise<void> {
    const { placeholders, values } = multiValues(
      rows.map((r) => [
        r.occurredAt,
        this.options.serviceName,
        this.options.environment,
        HOSTNAME,
        r.method,
        r.route ?? null,
        r.path,
        r.statusCode,
        r.durationMs,
        r.responseBytes ?? null,
        r.sourceIp ?? null,
        r.userAgent ?? null,
        r.userId ?? null,
        r.userEmail ?? null,
        r.serviceId ?? null,
        r.traceId ?? null,
        r.requestId,
        r.requestId,
      ]),
    );
    await this.pool.query(
      `INSERT INTO log.access_log
         (occurred_at, service_name, environment, hostname, method, route, path, status_code,
          duration_ms, response_bytes, source_ip, user_agent, user_id, user_email,
          service_id, trace_id, request_id, request_sid)
       VALUES ${placeholders}`,
      values,
    );
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.pool.end().catch((error: unknown) => {
      process.stderr.write(`log sink close failed: ${(error as Error).message}\n`);
      logCaught(error, 'config.log.sink.close.failed', { logger: 'logging.db-sink' });
    });
  }
}
