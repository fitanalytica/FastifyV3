import type { FastifyRequest } from 'fastify';
import type { AuthInfo } from '../../../types/index.js';

/** GET /{phone,wearable}/v3/me: who the token belongs to. */
export const meV3 = async (req: FastifyRequest): Promise<AuthInfo> => req.auth!;
