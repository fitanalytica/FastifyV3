import type { FastifyReply, FastifyRequest } from 'fastify';
import { restorePosts } from '../../../services/posts/restorePosts.js';
import type { PostsQuery } from '../../../types/index.js';

/** GET /phone/v3/posts?limit=50&before=<cursor>. The user's own posts, newest first, as JSON text. */
export const postsV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { limit, before } = req.query as PostsQuery;
  return reply.type('application/json').send(await restorePosts(req.server, req.userid!, { limit: limit ?? 50, before }));
};
