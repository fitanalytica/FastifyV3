import type { FastifyReply, FastifyRequest } from 'fastify';
import { getProfile } from '../../../services/profile/getProfile.js';

/** GET /phone/v3/profile. The user's profile and account, as JSON text. */
export const profileV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.type('application/json').send(await getProfile(req.server, req.userid!));
