import type { FastifyRequest } from 'fastify';
import { saveActivitiesBatch } from '../../../services/activities/batch.js';
import type { BatchBody, BatchResponse } from '../../../types/index.js';

/** POST /{phone,wearable}/v3/activities/batch (gzip allowed). HTTP 200 even if some items fail: see `results`. */
export const activitiesBatchV3 = (req: FastifyRequest): Promise<BatchResponse> =>
  saveActivitiesBatch(req.server, req.auth!, req.body as BatchBody);
