import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUserProfile } from '../../../services/users/getUserProfile.js';
import type { UserIdParams } from '../../../types/index.js';

/** GET /phone/v3/users/:userid. Someone's profile and the totals their stats are made from, as JSON text. */
export const userProfileV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.type('application/json').send(await getUserProfile(req.server, req.userid!, (req.params as UserIdParams).userid));
