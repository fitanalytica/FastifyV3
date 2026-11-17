import type { FastifyReply, FastifyRequest } from 'fastify';
import { removeMedia } from '../../../services/media/removeMedia.js';
import type { MediaParams } from '../../../types/index.js';

/** DELETE /phone/v3/media/:activityid/:value. Removes the file from the activity and from S3. 204. */
export const mediaRemoveV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { activityid, value } = req.params as MediaParams;
  await removeMedia(req.server, req.userid!, activityid, value);
  return reply.code(204).send();
};
