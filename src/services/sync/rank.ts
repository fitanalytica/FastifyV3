import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isRankUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { readRank as readRanks, writeTotals, type Keys, type Totals } from '../leaderboard/stepTotals.js';
import { codeOf } from './codeOf.js';

// The `rank` section (docs/data/sync.md section 4b): the user's totals for the current periods are **stored** (the phone counts, the server ranks: `services/leaderboard/stepTotals.ts`), and the answer is the user's place in
// each, with the five people around it, in `down.rank`. A request without totals and first days (an older phone) is answered with nothing.
export async function applyRank(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isRankUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  try {
    if (up.steps && up.keys) await writeTotals(app, userid, up.keys as Keys, up.steps as Totals);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: codeOf(app, e) };
  }
}

export async function readRank(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  if (!isRankUp(up) || !up.steps || !up.keys) return undefined;
  return { down: await readRanks(app, userid, up.keys as Keys, up.steps as Totals) };
}
