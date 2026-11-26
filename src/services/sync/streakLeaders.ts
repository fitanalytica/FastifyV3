import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isStreakLeadersUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { readStreakLeaders as readBoard } from '../leaderboard/streakStanding.js';

// The `streakLeaders` section is a read (docs/data/sync.md section 4d): the five places around the user on the streak leaderboard, in `down.streakLeaders`, from the streaks the phones sent (`streak_standing`).
export const applyStreakLeaders = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isStreakLeadersUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

export async function readStreakLeaders(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  return isStreakLeadersUp(up) ? { down: await readBoard(app, userid) } : undefined;
}
