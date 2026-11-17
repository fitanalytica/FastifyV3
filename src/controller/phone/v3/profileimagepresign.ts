import type { FastifyRequest } from 'fastify';
import { presignProfileImage } from '../../../services/media/profileImage.js';
import type { ProfilePresignBody } from '../../../types/index.js';

/** POST /phone/v3/profile/image/presign. An address to PUT the picture or the cover to, and the name it will have. */
export const profileImagePresignV3 = async (req: FastifyRequest) => presignProfileImage(req.server, req.userid!, req.body as ProfilePresignBody);
