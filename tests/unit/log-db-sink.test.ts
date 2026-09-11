import { loadConfig } from '@config/src/config.js';
import { createLogSink, LogDbSink } from '@config/src/logging/db-sink.js';
import { configureLogging } from '@config/src/logging.js';
import { describe, expect, it, vi } from 'vitest';

const secrets = () => ({ CONFIG_AGE_KEY: 'age-key', CONFIG_SESSION_SECRET: 'session-secret' });

const unusedPool = {
  on: () => undefined,
  query: vi.fn(async () => ({})),
  end: async () => undefined,
};

describe('createLogSink', () => {
  it('is absent when CONFIG_LOG_DATABASE_URL is unset, and logging still works', () => {
    expect(loadConfig(secrets()).logDatabaseUrl).toBeNull();
    expect(createLogSink({ logDatabaseUrl: null, environment: 'dev' })).toBeUndefined();
    expect(() => configureLogging('silent', true)).not.toThrow();
  });
});

describe('LogDbSink', () => {
  it('buffers request_sid onto both request columns and redacts secrets from attributes', async () => {
    const sink = new LogDbSink({
      databaseUrl: 'postgres://unused',
      serviceName: 'config.anudeep.pro',
      serviceVersion: '0.1.0',
      environment: 'dev',
      pool: unusedPool,
    });
    const stream = sink.stream();
    await new Promise<void>((resolve, reject) => {
      stream.write(
        `${JSON.stringify({
          level: 40,
          time: '2026-09-11T12:00:00.000Z',
          pid: 1,
          hostname: 'box',
          event: 'config.write.failed',
          logger: 'store.product-write',
          request_sid: 'sid_abc',
          SMTP_PASSWORD: 'hunter2',
          session_secret: 'cookie',
          errors: 'SESSION_TTL must be at least 60',
        })}\n`,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    const [row] = sink.peekApp();
    expect(row?.requestId).toBe('sid_abc');
    expect(row?.requestSid).toBe('sid_abc');
    expect(row?.message).toBe('Write failed');
    expect(row?.attributes.SMTP_PASSWORD).toBe('__redacted__');
    expect(row?.attributes.session_secret).toBe('__redacted__');
    expect(row?.attributes.errors).toBe('SESSION_TTL must be at least 60');
    await sink.close();
  });

  it('stores a processed message for debug lines and the stack on errors', async () => {
    const sink = new LogDbSink({
      databaseUrl: 'postgres://unused',
      serviceName: 'config.anudeep.pro',
      serviceVersion: '0.1.0',
      environment: 'dev',
      pool: unusedPool,
    });
    const stream = sink.stream();
    const boom = new Error('disk full');
    boom.stack = 'Error: disk full\n    at write (file.ts:1:1)';
    await new Promise<void>((resolve, reject) => {
      stream.write(
        `${JSON.stringify({
          level: 20,
          event: 'config.db.snapshot.ok',
          msg: 'Database snapshot completed (12.4ms)',
          duration_ms: 12.4,
          logger: 'store.db',
        })}\n`,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    await new Promise<void>((resolve, reject) => {
      stream.write(
        `${JSON.stringify({
          level: 50,
          event: 'config.write.failed',
          msg: 'Write failed: disk full',
          logger: 'store.db',
          err: { type: 'Error', message: 'disk full', stack: boom.stack },
        })}\n`,
        (error) => (error ? reject(error) : resolve()),
      );
    });

    const [debugLine, errorLine] = sink.peekApp();
    expect(debugLine?.message).toBe('Database snapshot completed (12.4ms)');
    expect(debugLine?.errorStack).toBeUndefined();
    expect(errorLine?.message).toContain('Write failed: disk full');
    expect(errorLine?.message).toContain('at write (file.ts:1:1)');
    expect(errorLine?.errorStack).toContain('at write (file.ts:1:1)');
    await sink.close();
  });

  it('does not throw when Postgres flush fails', async () => {
    const pool = {
      on: () => undefined,
      query: async () => {
        throw new Error('connection refused');
      },
      end: async () => undefined,
    };
    const sink = new LogDbSink({
      databaseUrl: 'postgres://down',
      serviceName: 'config.anudeep.pro',
      serviceVersion: '0.1.0',
      environment: 'dev',
      pool,
    });
    sink.pushAccess({
      occurredAt: new Date(),
      method: 'GET',
      path: '/login',
      statusCode: 200,
      durationMs: 1,
      requestId: 'sid_login',
    });
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.dropped).toBeGreaterThan(0);
    await sink.close();
  });
});
