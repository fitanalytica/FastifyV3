import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { isActivitiesUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { saveActivitiesBatch } from '../activities/batch.js';
import { deleteActivity } from '../activities/deleteActivity.js';
import { codeOf } from './codeOf.js';

// The `activities` section of the unified call (docs/data/sync.md): `delete` goes first (as the phone's loop always did), then `send` is the upload batch of docs/data/api.md section 2 and `delete` the activities the user deleted. The answer has
// `send`: one result per item, in the order sent (the same results as `POST /activities/batch`), and `delete`: for each id `ok`, `NOT_FOUND` (the phone treats it as done) or a code.
export async function applyActivities(app: FastifyInstance, { userid, auth }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isActivitiesUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  const result: SectionResult = { ok: true };
  if (up.delete) {
    const deleted: Record<string, string> = {};
    for (const id of up.delete) {
      try {
        await deleteActivity(app, userid, id);
        deleted[id] = 'ok';
      } catch (e) {
        deleted[id] = e instanceof AppError && e.statusCode === 404 ? ErrorCode.NOT_FOUND : codeOf(app, e);
        if (deleted[id] !== ErrorCode.NOT_FOUND) result.ok = false;
      }
    }
    result.delete = deleted;
  }
  if (up.send) {
    try {
      result.send = (await saveActivitiesBatch(app, auth, { activities: up.send })).results;
    } catch (e) {
      result.ok = false;
      result.code = codeOf(app, e);
      result.send = result.code;
    }
  }
  return result;
}
