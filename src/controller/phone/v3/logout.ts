import type { FastifyRequest } from 'fastify';
import { logoutUser } from '../../../services/auth/logoutUser.js';
import type { LogoutBody, LogoutResponse } from '../../../types/index.js';

/** POST /phone/v3/auth/logout. With a refresh token: that device only. Without: every device of the user. */
export const logoutV3 = (req: FastifyRequest): Promise<LogoutResponse> =>
  logoutUser(req.server, req.userid!, req.body as LogoutBody);
