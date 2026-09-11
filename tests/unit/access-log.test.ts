import { Writable } from 'node:stream';
import { attachAccessLog } from '@config/src/logging/access-log.js';
import { LogDbSink } from '@config/src/logging/db-sink.js';
import { bindRequestSid, requestSidLoggerOptions } from '@config/src/logging/request-context.js';
import { configureLogging } from '@config/src/logging.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

describe('accessLogPlugin', () => {
  it('records one row per request with the minted request_sid and no query string', async () => {
    const sink = new LogDbSink({
      databaseUrl: 'postgres://unused',
      serviceName: 'config.anudeep.pro',
      serviceVersion: '0.1.0',
      environment: 'dev',
      pool: { on: () => undefined, query: async () => ({}), end: async () => undefined },
    });
    const log = configureLogging('silent', true, {
      stream: () => new Writable({ write: (_c, _e, cb) => cb() }),
    });
    const app = Fastify(requestSidLoggerOptions(log));
    bindRequestSid(app);
    attachAccessLog(app, sink);
    app.get('/login', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/login?next=/p/iam' });
    const [row] = sink.peekAccess();

    expect(response.headers['x-request-sid']).toBe(row?.requestId);
    expect(row?.method).toBe('GET');
    expect(row?.path).toBe('/login');
    expect(row?.statusCode).toBe(200);
    await app.close();
    await sink.close();
  });

  it('writes an app log line when the response is 422', async () => {
    const sink = new LogDbSink({
      databaseUrl: 'postgres://unused',
      serviceName: 'config.anudeep.pro',
      serviceVersion: '0.1.0',
      environment: 'dev',
      pool: { on: () => undefined, query: async () => ({}), end: async () => undefined },
    });
    const log = configureLogging('warn', true, sink);
    const app = Fastify(requestSidLoggerOptions(log));
    bindRequestSid(app);
    attachAccessLog(app, sink);
    app.post('/p/new', async (_request, reply) => reply.code(422).send({ code: 'invalid' }));
    await app.ready();

    await app.inject({ method: 'POST', url: '/p/new' });
    const row = sink.peekApp().find((entry) => String(entry.attributes.status) === '422');

    expect(row?.level).toBe(40);
    expect(row?.message).toMatch(/Request failed/);
    expect(row?.message).toMatch(/POST \/p\/new/);
    expect(row?.attributes).toMatchObject({ method: 'POST', path: '/p/new', status: 422 });
    await app.close();
    await sink.close();
  });
});
