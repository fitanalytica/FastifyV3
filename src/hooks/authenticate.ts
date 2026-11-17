import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ErrorCode } from '../errors/codes.js';
import { errors } from '../errors/AppError.js';
import { checkAccess } from '../services/auth/checkAccess.js';
import { kindOfDevice } from '../services/auth/deviceKind.js';
import type { Kind } from '../types/index.js';

/** `altHeader`: a second header the bare token may come in. Only the media route sets it (`x-access-token`): the phone's image loader follows the redirect to S3
 *  itself and on some platforms keeps `Authorization` when it does, which S3 refuses ("multiple authentication types"); S3 ignores the other header. */
export interface AuthenticateOptions { altHeader?: string }

/** The token check as a hook: `fastify.authenticate('phone')` or `('watch')`. It refuses the other kind of token
 *  (a watch token on a phone route, and the reverse) and any device v3 does not serve (chrome, mac, no type). Used as `onRequest`, so it runs before the body is read
 *  and a bad token never costs a body parse. */
export default fp(async (app: FastifyInstance) => {
  app.decorate('authenticate', (kind: Kind, opts: AuthenticateOptions = {}) => async (req: FastifyRequest): Promise<void> => {
    // `Authorization` first; `opts.altHeader` (lower case) is where a token is also accepted, for the media route (see below).
    const alt = opts.altHeader ? req.headers[opts.altHeader] : undefined;
    const header = req.headers.authorization ?? (typeof alt === 'string' && alt ? `Bearer ${alt}` : undefined);
    const info = await checkAccess(app, header);
    if (kindOfDevice(info.deviceType) !== kind) throw errors.Forbidden('This token is for another kind of device', ErrorCode.WRONG_DEVICE);
    req.auth = info;
    req.userid = info.userid;
  });
});
