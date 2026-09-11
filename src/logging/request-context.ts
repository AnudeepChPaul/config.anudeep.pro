/**
 * Bind a minted request_sid to the Fastify request, the response header, and ALS.
 */

import { HEADER_REQUEST_SID, mintRequestSid } from '@config/src/logging/request-sid.js';
import { als, setUserEmail } from '@config/src/logging.js';
import type { FastifyInstance } from 'fastify';

export function requestSidLoggerOptions(logger?: FastifyInstance['log']) {
  return {
    ...(logger ? { loggerInstance: logger } : { logger: false as const }),
    genReqId: () => mintRequestSid(),
  };
}

export function bindRequestSid(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const requestSid = String(request.id);
    reply.header(HEADER_REQUEST_SID, requestSid);
    als.run({ requestSid }, done);
  });
}

/** After the session guard has run, so later log lines can name the operator. */
export function bindLogIdentity(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    setUserEmail(request.session?.email);
    done();
  });
}
