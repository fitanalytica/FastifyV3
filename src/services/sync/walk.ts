import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isWalkUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { putWalkHistory } from '../walk/putHistory.js';
import { putWalkToday } from '../walk/putToday.js';
import { codeOf } from './codeOf.js';

// The `walk` section of the unified call (docs/data/sync.md section 4): the bodies of `PUT /walk/history` and `PUT /walk/today`, history first. If history is refused, today waits (`WAITING`): a closed
// day's numbers are never overwritten on the server before they have arrived.
export async function applyWalk(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isWalkUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  const result: SectionResult = { ok: true };
  if (up.history) {
    try {
      await putWalkHistory(app, userid, up.history);
      result.history = 'ok';
    } catch (e) {
      result.ok = false;
      result.history = result.code = codeOf(app, e);
    }
  }
  if (up.today) {
    if (result.history && result.history !== 'ok') {
      result.today = 'WAITING';
    } else {
      try {
        await putWalkToday(app, userid, up.today);
        result.today = 'ok';
      } catch (e) {
        result.ok = false;
        result.today = result.code = codeOf(app, e);
      }
    }
  }
  return result;
}
