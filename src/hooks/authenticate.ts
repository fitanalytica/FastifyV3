import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ErrorCode } from '../errors/codes.js';
import { errors } from '../errors/AppError.js';
import { checkAccess } from '../services/auth/checkAccess.js';
import { kindOfDevice } from '../services/auth/deviceKind.js';
import type { Kind } from '../types/index.js';

/** The token check as a hook: `fastify.authenticate('phone')` or `('watch')`. It refuses the other kind of token
 *  (a watch token on a phone route, and the reverse) and any device v3 does not serve (chrome, mac, no type). Used as `onRequest`, so it runs before the body is read
 *  and a bad token never costs a body parse. */
export default fp(async (app: FastifyInstance) => {
  app.decorate('authenticate', (kind: Kind) => async (req: FastifyRequest): Promise<void> => {
    const info = await checkAccess(app, req.headers.authorization);
    if (kindOfDevice(info.deviceType) !== kind) throw errors.Forbidden('This token is for another kind of device', ErrorCode.WRONG_DEVICE);
    req.auth = info;
    req.userid = info.userid;
  });
});
