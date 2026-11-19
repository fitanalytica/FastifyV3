import type { FastifyReply, FastifyRequest } from 'fastify';
import { getState } from '../../../services/store/getState.js';
import type { StateQuery } from '../../../types/index.js';

/** GET /phone/v3/me/state?catalog=<version>&ads=<version>&platform=ios|android. What the user has (Pro, invite codes, bought protection days), what is on sale and the ad rules, as JSON text. */
export const stateV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.type('application/json').send(await getState(req.server, req.userid!, (req.query as StateQuery)));
