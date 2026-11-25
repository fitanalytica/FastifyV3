import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isStreakLeadersUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { countryName } from '../location/countries.js';
import { dummyStreakLeaders } from '../rank/dummyStreakLeaders.js';

// The `streakLeaders` section is a read (docs/data/sync.md section 4d): the five places around the user on the streak leaderboard, in `down.streakLeaders`, asked for in the same call as everything else.
export const applyStreakLeaders = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isStreakLeadersUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

export async function readStreakLeaders(app: FastifyInstance, ctx: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  if (!isStreakLeadersUp(up)) {
    return undefined;
  }
  const r = await app.pg.reader.query<{ iso: string | null }>('SELECT iso FROM userinfo WHERE userid = $1', [ctx.userid]);
  return { down: dummyStreakLeaders(up.days ?? 0, countryName(r.rows[0]?.iso ?? '') ?? '') };
}
