import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isRestoreUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { restoreActivities } from '../activities/restore.js';
import { readStreakRestore } from '../streak/readStreaks.js';
import { readWalk } from '../walk/readWalk.js';
import { codeOf } from './codeOf.js';

/** Rows in a restore page when the phone does not say, and the most it may ask for. */
export const RESTORE_PAGE = 200;
/** A page is cut to fit this many characters of JSON (about 1.5 MB): a few big activities do not make a huge answer. */
export const RESTORE_MAX_CHARS = 1_500_000;

// `restore` of the unified call (docs/data/sync.md section 5): the small parts in one go (the step history) and a page of activities, as JSON that is **not parsed here** (the large arrays go through as the
// database made them). Answered in `results.restore` and `down.restore = { walk?, streak?, activities? }`; `more` is true while there is a next page, so the phone asks again with the cursor.
export async function readRestore(app: FastifyInstance, { userid }: SyncContext, restore: unknown): Promise<{ result: SectionResult; down?: Record<string, unknown>; more?: boolean }> {
  if (!isRestoreUp(restore)) return { result: { ok: false, code: ErrorCode.BAD_REQUEST } };
  try {
    const down: Record<string, unknown> = {};
    let more = false;
    if (restore.walk) down.walk = await readWalk(app, userid);
    if (restore.streak) down.streak = await readStreakRestore(app, userid);
    if (restore.activities) {
      let limit = restore.activities.limit ?? RESTORE_PAGE;
      let text = await restoreActivities(app, userid, { limit, before: restore.activities.before });
      // Too big: ask again for fewer, in proportion (a page of big activities is rare; at most twice).
      for (let tries = 0; tries < 2 && text.length > RESTORE_MAX_CHARS && limit > 1; tries++) {
        limit = Math.max(1, Math.floor((limit * RESTORE_MAX_CHARS) / text.length));
        text = await restoreActivities(app, userid, { limit, before: restore.activities.before });
      }
      const page = JSON.parse(text) as { next: string | null };
      down.activities = page;
      more = page.next !== null;
    }
    return { result: { ok: true }, down, more };
  } catch (e) {
    return { result: { ok: false, code: codeOf(app, e) } };
  }
}
