import type { FastifyInstance } from 'fastify';
import { PERIODS, isPublic, keyOf, previousKey, rankBlockOf, type Board, type Keys, type Period } from './stepTotals.js';

// The distance leaderboard (docs/data/sync.md section 4i): the Ranking card of Activity stats. **Made by the server from the `activities` table**: a user's distance (metres) in the Week, Month, Year and All time is the sum of their
// activities that are not deleted (`tosend > 0`) by their local day (`dtgraph`). So activities of the old app count as well. The ranking is the one of the steps (`stepTotals.ts`): the rank is one more than the public users with at least as
// much (a tie goes to the other person); a private profile is left out of other people's ranking and still has its own place. There is no day period: a day's distance is one activity.

export const DISTANCE_BOARD: Board = { table: 'distance_totals', column: 'distance_m', field: 'distance' };
export type DistanceRankDown = Record<Exclude<Period, 'Day'>, { rank: number; of: number; change: number; people: { rank: number; name: string; place: string; distance: number; you?: true; userid?: string }[] }>;

/** A rebuild of a period's current rows is not repeated for this long (seconds); all time (the whole table) for longer. */
export const REBUILD_EVERY = 600;
export const REBUILD_ALL_TIME_EVERY = 3600;

const DAY = 86_400;
const utcLabel = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1000;

/** The first day (a label) of the week (Monday first), month and year that holds a day, and the first day of the next. */
export function periodRange(period: Exclude<Period, 'Day'>, day: number): { key: number; end: number | null } {
  const d = new Date(day * 1000);
  if (period === 'All time') return { key: 0, end: null };
  if (period === 'Week') {
    const monday = day - ((d.getUTCDay() + 6) % 7) * DAY;
    return { key: monday, end: monday + 7 * DAY };
  }
  if (period === 'Month') return { key: utcLabel(d.getUTCFullYear(), d.getUTCMonth(), 1), end: utcLabel(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
  return { key: utcLabel(d.getUTCFullYear(), 0, 1), end: utcLabel(d.getUTCFullYear() + 1, 0, 1) };
}

/** The periods to keep current: the ones holding yesterday, today and tomorrow in UTC (users are in every time zone), and the one before each (the places gone up are worked out against it). */
export function currentRanges(nowSec: number): { period: Exclude<Period, 'Day'>; index: number; key: number; end: number | null }[] {
  const today = Math.floor(nowSec / DAY) * DAY;
  const seen = new Set<string>();
  const out: { period: Exclude<Period, 'Day'>; index: number; key: number; end: number | null }[] = [];
  (['Week', 'Month', 'Year'] as const).forEach(period => {
    const index = PERIODS.indexOf(period);
    for (const day of [today - DAY, today, today + DAY]) {
      const { key } = periodRange(period, day);
      for (const k of [key, previousKey(period, key) as number]) {
        const id = `${period}:${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ period, index, ...periodRange(period, k) });
      }
    }
  });
  out.push({ period: 'All time', index: 4, key: 0, end: null });
  return out;
}

/** Rebuilds the rows of one period from the activities. A row that was not made this time (the user's activities there are all deleted) is removed. */
async function rebuild(app: FastifyInstance, r: { index: number; key: number; end: number | null }): Promise<void> {
  const w = app.pg.writer;
  // A mark for this run (milliseconds): the rows it makes carry it, so the ones it did not make (no activity left in the period) are known.
  const started = Date.now();
  await w.query(
    `INSERT INTO distance_totals (userid, period, key, distance_m, is_public, ddate)
     SELECT a.userid, $1::smallint, $2::bigint, sum(a.distance), NOT coalesce(u.hideprofile, false), $4::bigint
       FROM activities a JOIN userinfo u ON u.userid = a.userid
      WHERE a.tosend > 0 AND a.distance > 0 AND a.dtgraph >= $2 AND ($3::bigint IS NULL OR a.dtgraph < $3)
      GROUP BY a.userid, u.hideprofile
     ON CONFLICT (userid, period, key) DO UPDATE SET distance_m = EXCLUDED.distance_m, is_public = EXCLUDED.is_public, ddate = EXCLUDED.ddate`,
    [r.index, r.key, r.end, started],
  );
  await w.query('DELETE FROM distance_totals WHERE period = $1 AND key = $2 AND ddate <> $3', [r.index, r.key, started]);
}

/**
 * Rebuilds what is out of date (a period not rebuilt in `REBUILD_EVERY`, all time in `REBUILD_ALL_TIME_EVERY`), once at a time (an advisory lock: a read that finds it taken uses what is there).
 * Returns how many periods were rebuilt.
 */
export async function rebuildDistanceTotals(app: FastifyInstance, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  const c = await app.pg.writer.connect();
  try {
    const got = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(727001) AS ok');
    if (!got.rows[0].ok) return 0;
    try {
      let done = 0;
      for (const r of currentRanges(nowSec)) {
        const name = `distance:${r.index}:${r.key}`;
        const last = await c.query<{ at: string }>('SELECT at FROM leaderboard_runs WHERE name = $1', [name]);
        const every = r.index === 4 ? REBUILD_ALL_TIME_EVERY : REBUILD_EVERY;
        if (last.rows[0] && nowSec - Number(last.rows[0].at) < every) continue;
        await rebuild(app, r);
        await c.query('INSERT INTO leaderboard_runs (name, at) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET at = EXCLUDED.at', [name, nowSec]);
        done += 1;
      }
      return done;
    } finally {
      await c.query('SELECT pg_advisory_unlock(727001)');
    }
  } finally {
    c.release();
  }
}

/** The user's own distance in each period (from their activities, now) and written to the board, so their row is exact whatever the last rebuild said. */
async function ownTotals(app: FastifyInstance, userid: string, keys: Keys): Promise<Record<Exclude<Period, 'Day'>, number>> {
  const periods = ['Week', 'Month', 'Year', 'All time'] as const;
  const out = {} as Record<Exclude<Period, 'Day'>, number>;
  for (const p of periods) {
    const key = keyOf(keys, p);
    const end = p === 'All time' ? null : periodRange(p, key).end;
    const r = await app.pg.writer.query<{ d: string | null }>('SELECT sum(distance) AS d FROM activities WHERE userid = $1 AND tosend > 0 AND distance > 0 AND dtgraph >= $2 AND ($3::bigint IS NULL OR dtgraph < $3)', [userid, key, end]);
    const metres = Number(r.rows[0].d ?? 0);
    out[p] = metres;
    const index = PERIODS.indexOf(p);
    if (metres > 0) {
      await app.pg.writer.query(
        `INSERT INTO distance_totals (userid, period, key, distance_m, is_public, ddate)
         SELECT $1, $2::smallint, $3::bigint, $4::bigint, NOT coalesce(u.hideprofile, false), (EXTRACT(epoch FROM now()) * 1000)::bigint FROM (SELECT 1) x LEFT JOIN userinfo u ON u.userid = $1
         ON CONFLICT (userid, period, key) DO UPDATE SET distance_m = EXCLUDED.distance_m, is_public = EXCLUDED.is_public, ddate = EXCLUDED.ddate`,
        [userid, index, key, metres],
      );
    } else {
      await app.pg.writer.query('DELETE FROM distance_totals WHERE userid = $1 AND period = $2 AND key = $3', [userid, index, key]);
    }
  }
  return out;
}

/** `down.distanceRank`: the user's place in the current Week, Month, Year and All time by distance, with the five people around it. */
export async function readDistanceRank(app: FastifyInstance, userid: string, keys: Keys, nowSec = Math.floor(Date.now() / 1000)): Promise<DistanceRankDown> {
  await rebuildDistanceTotals(app, nowSec);
  const own = await ownTotals(app, userid, keys);
  const isPub = await isPublic(app, userid);
  const periods = ['Week', 'Month', 'Year', 'All time'] as const;
  const blocks = await Promise.all(periods.map(p => rankBlockOf(app, DISTANCE_BOARD, userid, p, PERIODS.indexOf(p), keys, own[p], isPub)));
  return Object.fromEntries(periods.map((p, i) => [p, blocks[i]])) as unknown as DistanceRankDown;
}
