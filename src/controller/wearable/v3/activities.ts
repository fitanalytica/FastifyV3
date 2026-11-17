import type { FastifyReply, FastifyRequest } from 'fastify';
import { restoreActivities } from '../../../services/activities/restore.js';
import type { WearableRestoreQuery } from '../../../types/index.js';

/** GET /wearable/v3/activities?limit=50. The watch's own most recent activities (`iswatch`, always: the watch never stores the phone's), once. */
export const activitiesV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { limit } = req.query as WearableRestoreQuery;
  return reply.type('application/json').send(await restoreActivities(req.server, req.userid!, { limit: limit ?? 50, iswatch: true }));
};
