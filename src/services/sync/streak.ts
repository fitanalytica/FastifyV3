import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isStreakUp, type SectionResult, type StreakUp, type SyncContext } from '../../types/index.js';
import { settledDays, writeLedger } from '../streak/ledger.js';
import { codeOf } from './codeOf.js';

// The `streak` section is storage (docs/data/sync.md section 4g): the phone decides the days (the rules are on the phone) and sends each streak that changed; the server keeps it as `streak_logs`, one row a streak. The
// server does not judge a day. It works out `duration` (the days that were not covered by protection) and `protection_used` from the days themselves, so those two can never disagree with them, and it refuses a streak
// that belongs to another user. Its protection days ledger (`protection_logs`) is appended to with it, from its days (`services/streak/ledger.ts`): events not there yet are added; nothing is removed or changed.

type Streak = StreakUp['streaks'][number];

const SQL = `
  INSERT INTO streak_logs (streak_id, userid, level_id, start_date, end_date, goal, duration, status, protection_used, daily_logs, ddate)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::streak_status, $9, $10::jsonb, EXTRACT(epoch FROM now())::bigint)
  ON CONFLICT (streak_id) DO UPDATE SET
    level_id = EXCLUDED.level_id, end_date = EXCLUDED.end_date, duration = EXCLUDED.duration, status = EXCLUDED.status,
    protection_used = EXCLUDED.protection_used, daily_logs = EXCLUDED.daily_logs, ddate = EXCLUDED.ddate
  WHERE streak_logs.userid = EXCLUDED.userid`;

/** The days that count (not covered by protection and not without data) and the protection days used, from the logs. */
export function countDays(streak: Pick<Streak, 'daily_logs'>): { duration: number; protectionUsed: number } {
  let duration = 0;
  let protectionUsed = 0;
  for (const level of streak.daily_logs) {
    for (const day of level.logs) {
      if (day.p) protectionUsed += 1;
      else if (!day.n) duration += 1;
    }
  }
  return { duration, protectionUsed };
}

export async function applyStreak(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isStreakUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  try {
    const refused: string[] = [];
    for (const s of up.streaks) {
      const { duration, protectionUsed } = countDays(s);
      // The streak and its ledger rows are written together (services/streak/ledger.ts): both or neither.
      const c = await app.pg.writer.connect();
      try {
        await c.query('BEGIN');
        // The days the server already holds for this streak are settled: the old app's streaks come with their days and their ledger as they were, and nothing is derived for those days (no back payment, no correction).
        const held = await c.query('SELECT daily_logs FROM streak_logs WHERE streak_id = $1 AND userid = $2 FOR UPDATE', [s.streak_id, userid]);
        const settled = settledDays((held.rows[0] as { daily_logs?: unknown } | undefined)?.daily_logs);
        const r = await c.query(SQL, [s.streak_id, userid, s.level_id, s.start_date, s.end_date ?? null, s.goal, duration, s.status, protectionUsed, JSON.stringify(s.daily_logs)]);
        if (!r.rowCount) {
          // No row written: the id is another user's.
          await c.query('ROLLBACK');
          refused.push(s.streak_id);
          continue;
        }
        await writeLedger(c, userid, s.streak_id, s.start_date, s.daily_logs, settled);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    }
    return refused.length ? { ok: false, code: ErrorCode.BAD_REQUEST, refused } : { ok: true };
  } catch (e) {
    return { ok: false, code: codeOf(app, e) };
  }
}
