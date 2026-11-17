import type { FastifyReply, FastifyRequest } from 'fastify';
import { getProfileImageUrl } from '../../../services/media/profileImage.js';
import type { ProfileImageParams } from '../../../types/index.js';

const redirect = (kind: 'pic' | 'bg') => async (req: FastifyRequest, reply: FastifyReply) => {
  const { userid, value } = req.params as ProfileImageParams;
  const url = await getProfileImageUrl(req.server, req.userid!, userid, kind, value);
  return reply.code(302).header('cache-control', 'private, max-age=600').header('location', url).send();
};

/** GET /phone/v3/profilepic/:userid/:value and /profilebg/:userid/:value. A 302 to a short-lived signed S3 address, as for activity media. */
export const profilePicV3 = redirect('pic');
export const profileBgV3 = redirect('bg');
