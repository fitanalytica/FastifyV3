import type { FastifyReply, FastifyRequest } from 'fastify';
import { inboxActivities } from '../../../services/activities/inbox.js';
import type { InboxQuery } from '../../../types/index.js';

/** GET /phone/v3/activities/inbox?limit=20. The body is JSON text from the database, sent as it is. */
export const inboxV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { limit } = req.query as InboxQuery;
  return reply.type('application/json').send(await inboxActivities(req.server, req.userid!, limit ?? 20));
};
