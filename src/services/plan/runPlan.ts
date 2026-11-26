import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { PlanUp } from '../../types/index.js';

// The running plan's progress (docs/data/sync.md section 4h), one row of `run_plans` per plan. The phone decides everything (the weeks, the days); the server stores, and never lets an older phone change what a newer
// one has written: the identity of a plan is written once, `weeks` only grows, `ended_on` is set once, and the settings (run days, tuning, pause) go to the latest `settings_at`.

export type PlanWeek = [number, 'o' | 'r' | 'b' | 'p', string];
export interface PlanRow {
  plan_id: string;
  started_on: number;
  race_on: number | null;
  ended_on: number | null;
  longest_run: number;
  distance: number;
  gen: number;
  total_weeks: number;
  run_days: number;
  long_day: number;
  pace_delta: number;
  volume_pm: number;
  tuned_from_week: number | null;
  paused_until: number | null;
  settings_at: number;
  weeks: PlanWeek[];
}

const COLUMNS = `plan_id, started_on, race_on, ended_on, longest_run, distance, gen, total_weeks, run_days, long_day, pace_delta, volume_pm, tuned_from_week, paused_until, settings_at, weeks`;
const BIGINTS = ['started_on', 'race_on', 'ended_on', 'paused_until', 'settings_at'] as const;

/** A row as the phone reads it: the bigint columns are numbers. */
export function rowOf(r: Record<string, unknown>): PlanRow {
  const out = { ...r } as Record<string, unknown>;
  for (const k of BIGINTS) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  return out as unknown as PlanRow;
}

/** What the server holds of the weeks after the phone's `weeks_from` entries are added: the weeks it has are never changed, and entries that are not next in line (a gap) are left out. */
export function mergeWeeks(held: PlanWeek[], from: number, sent: PlanWeek[]): PlanWeek[] {
  if (from > held.length) return held;
  return [...held, ...sent.slice(held.length - from)];
}

/** Stores the plan the phone sent. Returns how many weeks the server holds now (the phone sends from there), or `null` when the plan is another user's. */
export async function storePlan(app: FastifyInstance, userid: string, up: PlanUp['plan']): Promise<number | null> {
  const c: PoolClient = await app.pg.writer.connect();
  try {
    await c.query('BEGIN');
    const held = await c.query(`SELECT userid, ${COLUMNS} FROM run_plans WHERE plan_id = $1 FOR UPDATE`, [up.plan_id]);
    const w = JSON.stringify;
    if (!held.rowCount) {
      // A new plan: the one still active (if any) ended the day this one began.
      await c.query('UPDATE run_plans SET ended_on = $2, ddate = EXTRACT(epoch FROM now())::bigint WHERE userid = $1 AND ended_on IS NULL AND $3::bigint IS NULL', [userid, up.started_on, up.ended_on ?? null]);
      const weeks = mergeWeeks([], 0, up.weeks_from === 0 ? (up.weeks as PlanWeek[]) : []);
      await c.query(
        `INSERT INTO run_plans (plan_id, userid, started_on, race_on, ended_on, longest_run, distance, gen, total_weeks, run_days, long_day, pace_delta, volume_pm, tuned_from_week, paused_until, settings_at, weeks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)`,
        [up.plan_id, userid, up.started_on, up.race_on ?? null, up.ended_on ?? null, up.longest_run, up.distance, up.gen, up.total_weeks, up.run_days, up.long_day, up.pace_delta, up.volume_pm, up.tuned_from_week ?? null, up.paused_until ?? null, up.settings_at, w(weeks)],
      );
      await c.query('COMMIT');
      return weeks.length;
    }
    const row = held.rows[0] as Record<string, unknown> & { userid: string };
    if (row.userid !== userid) {
      await c.query('ROLLBACK');
      return null;
    }
    const weeks = mergeWeeks(row.weeks as PlanWeek[], up.weeks_from, up.weeks as PlanWeek[]);
    const newer = up.settings_at >= Number(row.settings_at);
    await c.query(
      `UPDATE run_plans SET
         weeks = $2::jsonb,
         ended_on = COALESCE(ended_on, $3),
         run_days = CASE WHEN $4 THEN $5 ELSE run_days END,
         long_day = CASE WHEN $4 THEN $6 ELSE long_day END,
         pace_delta = CASE WHEN $4 THEN $7 ELSE pace_delta END,
         volume_pm = CASE WHEN $4 THEN $8 ELSE volume_pm END,
         tuned_from_week = CASE WHEN $4 THEN $9 ELSE tuned_from_week END,
         paused_until = CASE WHEN $4 THEN $10 ELSE paused_until END,
         settings_at = CASE WHEN $4 THEN $11 ELSE settings_at END,
         ddate = EXTRACT(epoch FROM now())::bigint
       WHERE plan_id = $1`,
      [up.plan_id, w(weeks), up.ended_on ?? null, newer, up.run_days, up.long_day, up.pace_delta, up.volume_pm, up.tuned_from_week ?? null, up.paused_until ?? null, up.settings_at],
    );
    await c.query('COMMIT');
    return weeks.length;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** The plan a new phone takes: the active one, else the latest that ended (the "finished" state still shows). `null` when the user never had one. */
export async function readPlanRestore(app: FastifyInstance, userid: string): Promise<{ current: PlanRow | null }> {
  const r = await app.pg.reader.query(`SELECT ${COLUMNS} FROM run_plans WHERE userid = $1 ORDER BY (ended_on IS NULL) DESC, started_on DESC LIMIT 1`, [userid]);
  return { current: r.rows[0] ? rowOf(r.rows[0] as Record<string, unknown>) : null };
}
