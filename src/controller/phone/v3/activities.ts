import type { FastifyReply, FastifyRequest } from 'fastify';
import { restoreActivities } from '../../../services/activities/restore.js';
import type { RestoreQuery } from '../../../types/index.js';

/** GET /phone/v3/activities?limit=50&before=<cursor>. All the user's activities in full, newest first. JSON text from the database, sent as it is. */
export const activitiesV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { limit, before } = req.query as RestoreQuery;
  return reply.type('application/json').send(await restoreActivities(req.server, req.userid!, { limit: limit ?? 50, before }));
};
