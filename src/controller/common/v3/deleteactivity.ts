import type { FastifyReply, FastifyRequest } from 'fastify';
import { deleteActivity } from '../../../services/activities/deleteActivity.js';
import type { ActivityIdParams } from '../../../types/index.js';

/** DELETE /{phone,wearable}/v3/activities/:activityid. 204 when it is deleted, 404 for an unknown id (the app treats 404 as success). */
export const deleteActivityV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  await deleteActivity(req.server, req.userid!, (req.params as ActivityIdParams).activityid);
  return reply.code(204).send();
};
