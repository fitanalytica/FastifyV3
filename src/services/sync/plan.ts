import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isPlanUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { storePlan } from '../plan/runPlan.js';
import { codeOf } from './codeOf.js';

// The `plan` section is storage (docs/data/sync.md section 4h): the running plan as one row of `run_plans`, written so that nothing an older phone sends can change what a newer one wrote (`services/plan/runPlan.ts`).
// The answer says how many weeks the server holds (`weeks`): the phone sends from there on.
export async function applyPlan(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isPlanUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  try {
    const weeks = await storePlan(app, userid, up.plan);
    // A plan id that is another user's is refused and left as it was.
    return weeks === null ? { ok: false, code: ErrorCode.BAD_REQUEST, refused: [up.plan.plan_id] } : { ok: true, weeks };
  } catch (e) {
    return { ok: false, code: codeOf(app, e) };
  }
}
