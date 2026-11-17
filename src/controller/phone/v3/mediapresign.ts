import type { FastifyRequest } from 'fastify';
import { presign } from '../../../services/media/presign.js';
import type { ActivityIdParams, PresignBody } from '../../../types/index.js';

/** POST /phone/v3/media/:activityid/presign. An address to PUT one file to, and the name it will have. */
export const mediaPresignV3 = async (req: FastifyRequest) =>
  presign(req.server, req.userid!, (req.params as ActivityIdParams).activityid, req.body as PresignBody);
