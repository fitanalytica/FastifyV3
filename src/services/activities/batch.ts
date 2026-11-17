import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { AuthInfo, BatchBody, BatchResponse } from '../../types/index.js';
import { MAX_BATCH, upsertBatch } from './upsert.js';

/** The upload: refuses a bad request as a whole (400 BAD_BATCH), otherwise answers per item (HTTP 200). */
export async function saveActivitiesBatch(app: FastifyInstance, auth: AuthInfo, body: BatchBody): Promise<BatchResponse> {
  const list = body.activities;
  if (!Array.isArray(list) || list.length === 0) throw errors.BadRequest('activities must be a non-empty array', ErrorCode.BAD_BATCH);
  if (list.length > MAX_BATCH) throw errors.BadRequest(`at most ${MAX_BATCH} activities per request`, ErrorCode.BAD_BATCH);
  return { results: await upsertBatch(app, auth, list) };
}
