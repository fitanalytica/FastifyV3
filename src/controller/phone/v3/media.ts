import type { FastifyReply, FastifyRequest } from 'fastify';
import { getMediaUrl } from '../../../services/media/mediaUrl.js';
import type { MediaParams } from '../../../types/index.js';

/** GET /phone/v3/media/:activityid/:value. Redirects to a short-lived S3 address of the file. The redirect itself may be kept for a few minutes. */
export const mediaV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  const { activityid, value } = req.params as MediaParams;
  const url = await getMediaUrl(req.server, req.userid!, activityid, value);
  return reply.code(302).header('cache-control', 'private, max-age=600').header('location', url).send();
};
