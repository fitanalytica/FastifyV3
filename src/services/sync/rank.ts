import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isRankUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { dummyRank } from '../rank/dummyRank.js';

// The `rank` section is a read (docs/data/sync.md section 4b): the user's place on the step leaderboards, in `down.rank`, asked for about every six hours.
export const applyRank = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isRankUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

// Everyone gets their own rank, **private users too**; a private user is only left out of everyone else's: not counted in their ranks and never shown as their neighbour (the real leaderboard ranks the public users and
// places a private user among them; the dummy only has made-up public neighbours).
export async function readRank(_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  return isRankUp(up) ? { down: dummyRank(up) } : undefined;
}
