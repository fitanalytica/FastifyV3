import type { FastifyRequest } from 'fastify';
import { devLogin } from '../../../services/auth/devLogin.js';
import type { DevLoginBody, DevLoginResponse } from '../../../types/index.js';

/** POST /phone/v3/auth/dev-login. LOCAL TESTING ONLY: without DEV_LOGIN=true it answers 404 like an unknown route. */
export const devLoginV3 = (req: FastifyRequest): Promise<DevLoginResponse> =>
  devLogin(req.server, req.body as DevLoginBody, req.ip);
