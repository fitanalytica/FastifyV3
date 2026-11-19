import type { FastifyReply, FastifyRequest } from 'fastify';
import { handleAppStoreNotification } from '../../../services/store/handleAppStoreNotification.js';
import type { AppStoreNotificationBody } from '../../../types/index.js';

/** POST /store/v3/appstore. The App Store's notification: checked, kept, and applied. 200 when done (anything else makes the App Store send it again). */
export const appStoreNotificationV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  await handleAppStoreNotification(req.server, (req.body as AppStoreNotificationBody).signedPayload);
  return reply.code(200).send({ success: true });
};
