import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isDistanceRankUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { readDistanceRank as readBoard } from '../leaderboard/distanceTotals.js';
import type { Keys } from '../leaderboard/stepTotals.js';

// The `distanceRank` section is a read (docs/data/sync.md section 4i): the user's place on the distance leaderboard, made by the server from its `activities` table, in `down.distanceRank`.
export const applyDistanceRank = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isDistanceRankUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

export async function readDistanceRank(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  if (!isDistanceRankUp(up)) return undefined;
  // The day period is not ranked; its key is not used.
  return { down: await readBoard(app, userid, { Day: 0, ...up.keys } as Keys) };
}
