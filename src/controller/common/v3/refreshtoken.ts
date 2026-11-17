import type { FastifyRequest } from 'fastify';
import { refreshAuthTokens } from '../../../services/auth/refreshAuthTokens.js';
import type { RefreshBody, Tokens } from '../../../types/index.js';

/** POST /{phone,wearable}/v3/auth/refresh. No access token needed: the access token is the thing that expired. */
export const refreshTokenV3 = (req: FastifyRequest): Promise<Tokens> =>
  refreshAuthTokens(req.server, req.body as RefreshBody);
