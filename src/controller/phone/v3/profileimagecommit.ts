import type { FastifyRequest } from 'fastify';
import { commitProfileImage } from '../../../services/media/profileImage.js';
import type { ProfileCommitBody } from '../../../types/index.js';

/** POST /phone/v3/profile/image/commit. The file is uploaded: it becomes the picture or the cover. Answers `{ value }`. */
export const profileImageCommitV3 = async (req: FastifyRequest) => ({
  value: await commitProfileImage(req.server, req.userid!, req.body as ProfileCommitBody),
});
