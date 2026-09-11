import { Writable } from 'node:stream';
import { bindRequestSid, requestSidLoggerOptions } from '@config/src/logging/request-context.js';
import { HEADER_REQUEST_SID, mintRequestSid } from '@config/src/logging/request-sid.js';
import { als, configureLogging } from '@config/src/logging.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

describe('mintRequestSid', () => {
  it('mints a sid_ token that is unique per call', () => {
    const first = mintRequestSid();
    const second = mintRequestSid();

    expect(first).toMatch(/^sid_[0-9a-f-]{36}$/);
    expect(second).toMatch(/^sid_[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });
});

describe('pino mixin', () => {
  it('stamps request_sid on lines emitted inside the request context', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const log = configureLogging('info', true, { stream: () => stream });

    als.run({ requestSid: 'sid_test' }, () => {
      log.info({ logger: 'test' }, 'config.test.line');
    });
    log.info({ logger: 'test' }, 'config.test.outside');

    const inside = lines.map((line) => JSON.parse(line) as { request_sid?: string; event: string });
    expect(inside.find((row) => row.event === 'config.test.line')?.request_sid).toBe('sid_test');
    expect(inside.find((row) => row.event === 'config.test.outside')?.request_sid).toBeUndefined();
  });
});

describe('bindRequestSid', () => {
  it('sets X-Request-Sid from a minted value and ignores an inbound header', async () => {
    const log = configureLogging('silent', true);
    const app = Fastify(requestSidLoggerOptions(log));
    bindRequestSid(app);
    app.get('/healthz', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { [HEADER_REQUEST_SID]: 'sid_attacker-chosen-value-00000000' },
    });

    const sid = response.headers[HEADER_REQUEST_SID.toLowerCase()];
    expect(response.statusCode).toBe(200);
    expect(sid).toMatch(/^sid_[0-9a-f-]{36}$/);
    expect(sid).not.toBe('sid_attacker-chosen-value-00000000');
    await app.close();
  });
});
