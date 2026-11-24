import type { FastifyReply, FastifyRequest } from 'fastify';
import { handlePlayNotification } from '../../../services/store/handlePlayNotification.js';
import type { PlayNotificationBody } from '../../../types/index.js';

/** POST /store/v3/playstore. Google Play's real-time developer notification, pushed by Pub/Sub: its token checked, the notification kept and applied. 200 when done (anything else makes Pub/Sub send it again). */
export const playNotificationV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  await handlePlayNotification(req.server, req.headers.authorization, req.body as PlayNotificationBody);
  return reply.code(200).send({ success: true });
};
