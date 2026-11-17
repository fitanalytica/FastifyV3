import type { FastifyReply, FastifyRequest } from 'fastify';
import { etagOf, getFeed } from '../../../services/feed/getFeed.js';
import type { FeedQuery } from '../../../types/index.js';

/** GET /phone/v3/feed?limit=20&before=<cursor>. A page of the most recent activities of public users, as JSON text. 304 when the phone already has this page (its ETag). */
export const feedV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { limit, before } = req.query as FeedQuery;
  const body = await getFeed(req.server, { limit: limit ?? 20, before });
  const etag = etagOf(body);
  reply.header('etag', etag).header('cache-control', 'private, no-cache');
  return req.headers['if-none-match'] === etag ? reply.code(304).send() : reply.type('application/json').send(body);
};
