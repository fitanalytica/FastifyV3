import type { FastifyRequest } from 'fastify';
import { commitMedia } from '../../../services/media/commit.js';
import type { ActivityIdParams, CommitBody } from '../../../types/index.js';

/** POST /phone/v3/media/:activityid/commit. The file is uploaded: add it. Answers the activity's whole `media_v2`. */
export const mediaCommitV3 = async (req: FastifyRequest) => ({
  media_v2: await commitMedia(req.server, req.userid!, (req.params as ActivityIdParams).activityid, req.body as CommitBody),
});
