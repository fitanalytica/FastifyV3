import type { FastifyReply, FastifyRequest } from 'fastify';
import { resetProfileImage } from '../../../services/media/profileImage.js';
import type { ProfileKindParams } from '../../../types/index.js';

/** DELETE /phone/v3/profile/image/:kind (`pic` or `bg`). Back to no image; the file is deleted. 204, also when there was none. */
export const profileImageResetV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  await resetProfileImage(req.server, req.userid!, (req.params as ProfileKindParams).kind);
  return reply.code(204).send();
};
