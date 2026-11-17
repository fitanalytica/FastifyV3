import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPublicActivity } from '../../../services/feed/getPublicActivity.js';
import type { ActivityIdParams } from '../../../types/index.js';

/** GET /phone/v3/feed/:activityid. One activity of someone else in full, with its author, as JSON text. */
export const feedActivityV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.type('application/json').send(await getPublicActivity(req.server, req.userid!, (req.params as ActivityIdParams).activityid));
