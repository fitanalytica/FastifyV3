import type { FastifyInstance } from 'fastify';
import { countryName } from '../location/countries.js';
import { pickWindow } from './window.js';

// The step leaderboards (docs/data/sync.md sections 4b and 4c): `step_totals` has each user's steps in the current Day, Week, Month, Year and All time, **sent by the phone** (it counts; the server stores and ranks). A rank is the
// number of public users with at least as many steps in the same period (a tie goes to the other person) plus one. **A private profile is left out of everyone else's ranking** (not counted, never a neighbour) **but still gets its own rank**,
// among the public users (`is_public` is the inverse of `userinfo.hideprofile`; it follows the profile: `setVisibility`).

export const PERIODS = ['Day', 'Week', 'Month', 'Year', 'All time'] as const;
export type Period = (typeof PERIODS)[number];
export type Totals = Record<Period, number>;
/** The label (the local date as UTC midnight, seconds) of each period's first day, as the phone sends them: all time has none. */
export type Keys = Record<Exclude<Period, 'All time'>, number>;
export const keyOf = (keys: Keys, p: Period) => (p === 'All time' ? 0 : keys[p]);

export type RankPerson = { rank: number; name: string; place: string; steps: number; you?: true; userid?: string };
export type RankBlock = { rank: number; of: number; change: number; people: RankPerson[] };
export type RankDown = Record<Period, RankBlock>;
export type ChallengerPerson = { rank: number; name: string; country: string; iso?: string; steps: number; you?: true; userid?: string; pic?: string };
export type ChallengersDown = { rank: number; of: number; count: number; country: string; iso: string; top: ChallengerPerson[] };

/** A leaderboard's table: the steps (`step_totals`, `steps`) or the distance (`distance_totals`, metres; `services/leaderboard/distanceTotals.ts`). The names are fixed here, never from a request. */
export type Board = { table: 'step_totals' | 'distance_totals'; column: 'steps' | 'distance_m'; field: 'steps' | 'distance' };
export const STEPS_BOARD: Board = { table: 'step_totals', column: 'steps', field: 'steps' };

export const CHALLENGERS = 8;
/** Fewer people than this with steps today and the phone keeps showing the last full list. */
const MIN_BOARD = CHALLENGERS;

/** The first day of the period before (a label), or `null` for all time. */
export function previousKey(period: Period, key: number): number | null {
  if (period === 'All time') return null;
  if (period === 'Day') return key - 86_400;
  if (period === 'Week') return key - 7 * 86_400;
  const d = new Date(key * 1000);
  return (period === 'Month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) : Date.UTC(d.getUTCFullYear() - 1, 0, 1)) / 1000;
}

/** Stores the totals the phone sent for the current periods (a zero is left as it was: a new period has a new key). */
export async function writeTotals(app: FastifyInstance, userid: string, keys: Keys, steps: Totals): Promise<void> {
  const rows = PERIODS.map((p, i) => ({ period: i, key: keyOf(keys, p), steps: steps[p] })).filter(r => r.steps > 0);
  if (!rows.length) return;
  await app.pg.writer.query(
    `INSERT INTO step_totals (userid, period, key, steps, is_public, ddate)
     SELECT $1, v.period, v.key, v.steps, NOT coalesce(u.hideprofile, false), EXTRACT(epoch FROM now())::bigint
       FROM unnest($2::smallint[], $3::bigint[], $4::int[]) AS v(period, key, steps)
       LEFT JOIN userinfo u ON u.userid = $1
     ON CONFLICT (userid, period, key) DO UPDATE SET steps = EXCLUDED.steps, is_public = EXCLUDED.is_public, ddate = EXCLUDED.ddate`,
    [userid, rows.map(r => r.period), rows.map(r => r.key), rows.map(r => r.steps)],
  );
}

type Row = { userid: string; steps: number; name: string; city: string | null; iso: string | null; pic: string | null };
const WHO = `trim(concat_ws(' ', u.fname, u.lname)) AS name, u.city, u.iso, u.profilepic AS pic`;

/** The people just above (nearest first) and just below the user in a period, among the public users. */
async function neighbours(app: FastifyInstance, userid: string, period: number, key: number, steps: number, b: Board = STEPS_BOARD): Promise<{ above: Row[]; below: Row[] }> {
  const q = (cond: string, order: string) =>
    app.pg.reader.query<Row>(
      `SELECT t.userid, t.${b.column} AS steps, ${WHO} FROM ${b.table} t JOIN userinfo u ON u.userid = t.userid
        WHERE t.period = $1 AND t.key = $2 AND t.is_public AND t.userid <> $3 AND ${cond} ORDER BY ${order} LIMIT 4`,
      [period, key, userid, steps],
    );
  const c = `t.${b.column}`;
  const [above, below] = await Promise.all([q(`${c} >= $4`, `${c} ASC, t.userid DESC`), q(`${c} < $4`, `${c} DESC, t.userid ASC`)]);
  return { above: above.rows, below: below.rows };
}

/** How many public users have at least `steps` (not the user), and how many there are in all. */
async function standing(app: FastifyInstance, userid: string, period: number, key: number, steps: number, b: Board = STEPS_BOARD): Promise<{ ahead: number; total: number }> {
  const r = await app.pg.reader.query<{ ahead: string; total: string }>(
    `SELECT count(*) FILTER (WHERE ${b.column} >= $4 AND userid <> $3) AS ahead, count(*) AS total FROM ${b.table} WHERE period = $1 AND key = $2 AND is_public`,
    [period, key, userid, steps],
  );
  return { ahead: Number(r.rows[0].ahead), total: Number(r.rows[0].total) };
}

const place = (r: Row) => [r.city, countryName(r.iso ?? '')].filter(Boolean).join(', ');

export async function isPublic(app: FastifyInstance, userid: string): Promise<boolean> {
  const r = await app.pg.reader.query<{ hidden: boolean | null }>('SELECT hideprofile AS hidden FROM userinfo WHERE userid = $1', [userid]);
  return !r.rows[0]?.hidden;
}

/** One period's window on a board, as `down.rank` (steps) or `down.distanceRank` (metres, in `distance`) gives it. */
export async function rankBlockOf(app: FastifyInstance, b: Board, userid: string, p: Period, i: number, keys: Keys, value: number, isPub: boolean): Promise<{ rank: number; of: number; change: number; people: Record<string, unknown>[] }> {
  const key = keyOf(keys, p);
  const { ahead, total } = await standing(app, userid, i, key, value, b);
  const rank = ahead + 1;
  const { above, below } = await neighbours(app, userid, i, key, value, b);
  const w = pickWindow(above, below);
  // A private user takes a place that is nobody else's: the people below them are numbered after it.
  const person = (r: Row, n: number) => ({ rank: n, name: r.name || 'Anonymous', place: place(r), [b.field]: r.steps, userid: r.userid });
  const people = [
    ...w.above.map((r, k) => person(r, rank - w.above.length + k)),
    { rank, name: 'You', place: '', [b.field]: value, you: true },
    ...w.below.map((r, k) => person(r, rank + 1 + k)),
  ];
  // The places gone up since the period before: where the user stood then, from the row they had.
  let change = 0;
  const prev = previousKey(p, key);
  if (prev !== null) {
    const was = await app.pg.reader.query<{ v: number }>(`SELECT ${b.column} AS v FROM ${b.table} WHERE userid = $1 AND period = $2 AND key = $3`, [userid, i, prev]);
    if (was.rows[0]) {
      const before = await standing(app, userid, i, prev, Number(was.rows[0].v), b);
      change = before.ahead + 1 - rank;
    }
  }
  return { rank, of: total + (isPub && value > 0 ? 0 : 1), change, people };
}

/** `down.rank`: the user's place in the current period of each kind, with the five people around it. Needs the totals and the first days the phone sent. */
export async function readRank(app: FastifyInstance, userid: string, keys: Keys, steps: Totals): Promise<RankDown> {
  const isPub = await isPublic(app, userid);
  const blocks = (await Promise.all(PERIODS.map((p, i) => rankBlockOf(app, STEPS_BOARD, userid, p, i, keys, steps[p], isPub))));
  return Object.fromEntries(PERIODS.map((p, i) => [p, blocks[i]])) as unknown as RankDown;
}

/** `down.challengers`: today's first eight, the user's rank among the public users with steps today, and how many there are. */
export async function readChallengers(app: FastifyInstance, userid: string, day: number, steps: number): Promise<ChallengersDown> {
  const me = await app.pg.reader.query<{ iso: string | null }>('SELECT iso FROM userinfo WHERE userid = $1', [userid]);
  const iso = (me.rows[0]?.iso ?? '').toUpperCase();
  const country = countryName(iso) ?? '';
  const { ahead, total } = await standing(app, userid, 0, day, steps);
  const isPub = await isPublic(app, userid);
  const rank = steps > 0 ? ahead + 1 : Math.max(total, CHALLENGERS) + 1;
  const count = total + (isPub || steps <= 0 ? 0 : 1);
  if (total < MIN_BOARD) {
    return { rank, of: count, count, country, iso, top: [] };
  }
  const r = await app.pg.reader.query<Row>(
    `SELECT t.userid, t.steps, ${WHO} FROM step_totals t JOIN userinfo u ON u.userid = t.userid
      WHERE t.period = 0 AND t.key = $1 AND t.is_public ORDER BY t.steps DESC, t.userid ASC LIMIT ${CHALLENGERS}`,
    [day],
  );
  const top = r.rows.map((p, i): ChallengerPerson => ({
    rank: i + 1,
    name: p.name || 'Anonymous',
    country: countryName(p.iso ?? '') ?? '',
    ...(p.iso ? { iso: p.iso.toUpperCase() } : {}),
    steps: p.steps,
    ...(p.userid === userid ? { you: true as const } : {}),
    ...(p.pic ? { userid: p.userid, pic: p.pic } : {}),
  }));
  return { rank, of: count, count, country, iso, top };
}

/** The visibility of a profile changed: its rows in every leaderboard follow it. */
export async function setBoardsVisibility(app: FastifyInstance, userid: string, hidden: boolean): Promise<void> {
  await app.pg.writer.query('UPDATE distance_totals SET is_public = $2 WHERE userid = $1', [userid, !hidden]);
  await app.pg.writer.query('UPDATE step_totals SET is_public = $2 WHERE userid = $1', [userid, !hidden]);
  await app.pg.writer.query('UPDATE streak_standing SET is_public = $2 WHERE userid = $1', [userid, !hidden]);
}
