import type { FastifyInstance } from 'fastify';
import { countryName } from '../location/countries.js';
import { pickWindow } from './window.js';

// The streak leaderboard (docs/data/sync.md section 4d): `streak_standing` has one row for each user whose streak is running, with its days, **written when the phone sends the streak** (the days are counted on the phone and
// worked out from the streak's days by the server: `countDays`). A streak not heard of for `FRESH_DAYS` is left out (the phone may have stopped). A private profile is left out of everyone else's board and still has its own place.

export type StreakLeaderPerson = { rank: number; name: string; country: string; days: number; you?: true };
export type StreakLeadersDown = { rank: number; of: number; people: StreakLeaderPerson[] };
export const FRESH_DAYS = 3;

/** A streak was stored: the user's row follows it. A running streak with days sets it; the end of the streak that is in the row, or no days yet, removes it. */
export async function setStanding(app: FastifyInstance, userid: string, streakId: string, status: string, days: number): Promise<void> {
  if (status === 'in_progress' && days > 0) {
    await app.pg.writer.query(
      `INSERT INTO streak_standing (userid, streak_id, days, is_public, ddate)
       SELECT $1, $2, $3, NOT coalesce(u.hideprofile, false), EXTRACT(epoch FROM now())::bigint FROM (SELECT 1) x LEFT JOIN userinfo u ON u.userid = $1
       ON CONFLICT (userid) DO UPDATE SET streak_id = EXCLUDED.streak_id, days = EXCLUDED.days, is_public = EXCLUDED.is_public, ddate = EXCLUDED.ddate`,
      [userid, streakId, days],
    );
    return;
  }
  await app.pg.writer.query('DELETE FROM streak_standing WHERE userid = $1 AND streak_id = $2', [userid, streakId]);
}

type Row = { userid: string; days: number; name: string; iso: string | null };
const WHO = `trim(concat_ws(' ', u.fname, u.lname)) AS name, u.iso`;

export async function readStreakLeaders(app: FastifyInstance, userid: string): Promise<StreakLeadersDown> {
  const cutoff = Math.floor(Date.now() / 1000) - FRESH_DAYS * 86_400;
  const mine = await app.pg.reader.query<{ days: number }>('SELECT days FROM streak_standing WHERE userid = $1 AND ddate > $2', [userid, cutoff]);
  const days = mine.rows[0]?.days ?? 0;
  const board = `FROM streak_standing s JOIN userinfo u ON u.userid = s.userid WHERE s.is_public AND s.ddate > $1 AND s.userid <> $2`;
  const count = await app.pg.reader.query<{ ahead: string; total: string }>(
    `SELECT count(*) FILTER (WHERE s.days >= $3) AS ahead, count(*) AS total ${board}`,
    [cutoff, userid, Math.max(days, 1)],
  );
  // With no streak running the user is after everyone on the board.
  const ahead = days > 0 ? Number(count.rows[0].ahead) : Number(count.rows[0].total);
  const rank = ahead + 1;
  const q = (cond: string, order: string, params: unknown[]) =>
    app.pg.reader.query<Row>(`SELECT s.userid, s.days, ${WHO} ${board} AND ${cond} ORDER BY ${order} LIMIT 4`, [cutoff, userid, ...params]);
  const [above, below] =
    days > 0
      ? await Promise.all([q('s.days >= $3', 's.days ASC, s.userid DESC', [days]), q('s.days < $3', 's.days DESC, s.userid ASC', [days])])
      : [await q('true', 's.days ASC, s.userid DESC', []), { rows: [] as Row[] }];
  const w = pickWindow(above.rows, below.rows);
  const person = (r: Row, n: number): StreakLeaderPerson => ({ rank: n, name: r.name || 'Anonymous', country: countryName(r.iso ?? '') ?? '', days: r.days });
  const people: StreakLeaderPerson[] = [
    ...w.above.map((r, k) => person(r, rank - w.above.length + k)),
    { rank, name: 'You', country: '', days, you: true },
    ...w.below.map((r, k) => person(r, rank + 1 + k)),
  ];
  return { rank, of: Number(count.rows[0].total) + 1, people };
}
