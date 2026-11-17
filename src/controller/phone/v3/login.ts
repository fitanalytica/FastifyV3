import type { FastifyRequest } from 'fastify';
import { login } from '../../../services/auth/login.js';
import type { LoginBody, LoginResponse } from '../../../types/index.js';

/** POST /phone/v3/auth/login. Sign in with Apple or Google (docs/data/api.md section 1b). */
export const loginV3 = (req: FastifyRequest): Promise<LoginResponse> => login(req.server, req.body as LoginBody);
