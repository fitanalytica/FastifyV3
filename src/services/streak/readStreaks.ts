import type { FastifyInstance } from 'fastify';

// What a new phone takes of the streak (the restore, docs/data/sync.md section 5): the streak to carry on (the running one, else the latest that ended), the ones before it as lines, and the protection days the user
// has earned and not spent. Read as stored: the old app's streaks come as they are (a failed one ends with the day it failed on: `services/streak/legacy.ts`; the phone reads it so).

export interface StreakRestoreRow {
  streak_id: string;
  level_id: string;
  start_date: number;
  end_date: number | null;
  goal: number;
  duration: number;
  status: 'in_progress' | 'completed' | 'failed';
  protection_used: number;
  daily_logs: unknown;
}
export interface PastStreakLine {
  streak_id: string;
  start_date: number;
  end_date: number | null;
  duration: number;
  status: StreakRestoreRow['status'];
  goal: number;
  /** The streak's days, as stored (the calendar shows them): for the newest streaks, until PAST_DAYS_LIMIT days in all; older lines come without. */
  daily_logs: unknown | null;
}
export interface StreakRestore {
  /** The streak to carry on, or `null` when the user never had one. */
  current: StreakRestoreRow | null;
  /** The streaks before it, newest first, as lines (the most that is shown). */
  past: PastStreakLine[];
  /** The protection days earned and not spent: the sum of the `grant` and `consume` rows. What was bought (`iap`) is not in it: the store state carries each purchase, once, on its own. */
  balance: number;
}

/** How many earlier streaks come as lines. */
export const PAST_LIMIT = 20;
/** The most days the earlier streaks bring with them in all (about 30 bytes a day): the newest first, the rest as lines only. */
export const PAST_DAYS_LIMIT = 3000;

const daysIn = (logs: unknown): number => (Array.isArray(logs) ? logs.reduce((t: number, l: { logs?: unknown }) => t + (Array.isArray(l?.logs) ? l.logs.length : 0), 0) : 0);

export async function readStreakRestore(app: FastifyInstance, userid: string): Promise<StreakRestore> {
  const r = await app.pg.reader.query<StreakRestoreRow & { start_date: string; end_date: string | null }>(
    `SELECT streak_id, level_id, start_date, end_date, goal, duration, status, protection_used, daily_logs
       FROM streak_logs WHERE userid = $1 ORDER BY start_date DESC, ddate DESC LIMIT $2`,
    [userid, PAST_LIMIT + 5],
  );
  const rows = r.rows.map(x => ({ ...x, start_date: Number(x.start_date), end_date: x.end_date === null ? null : Number(x.end_date) }));
  // The one to carry on: the latest that is still running, else the latest of all (it shows as ended).
  const current = rows.find(x => x.status !== 'failed') ?? rows[0] ?? null;
  let budget = PAST_DAYS_LIMIT;
  const past = rows
    .filter(x => x !== current)
    .slice(0, PAST_LIMIT)
    .map((x): PastStreakLine => {
      const n = daysIn(x.daily_logs);
      const withDays = n > 0 && n <= budget;
      if (withDays) budget -= n;
      return { streak_id: x.streak_id, start_date: x.start_date, end_date: x.end_date, duration: x.duration, status: x.status, goal: x.goal, daily_logs: withDays ? x.daily_logs : null };
    });
  const b = await app.pg.reader.query<{ balance: string | null }>(`SELECT sum(protection_days) AS balance FROM protection_logs WHERE userid = $1 AND transaction_type IN ('grant', 'consume')`, [userid]);
  return { current, past, balance: Number(b.rows[0]?.balance ?? 0) };
}
