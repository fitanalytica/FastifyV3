import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUserFeed } from '../../../services/users/getUserFeed.js';
import type { UserFeedQuery, UserIdParams } from '../../../types/index.js';

/** GET /phone/v3/users/:userid/feed?limit&before&kind&media. A page of one user's activities and posts, in the feed's shape, as JSON text. */
export const userFeedV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { limit, ...rest } = req.query as UserFeedQuery;
  const body = await getUserFeed(req.server, req.userid!, (req.params as UserIdParams).userid, { limit: limit ?? 20, ...rest });
  return reply.type('application/json').send(body);
};
