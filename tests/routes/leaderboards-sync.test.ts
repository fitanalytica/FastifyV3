import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { previousKey } from '../../src/services/leaderboard/stepTotals.js';
import { pickWindow } from '../../src/services/leaderboard/window.js';
import { setBoardsVisibility } from '../../src/services/leaderboard/stepTotals.js';

// The leaderboards (docs/data/sync.md sections 4b, 4c, 4d): the phone's totals are stored and ranked by the server. The keys are made up and far from today's, so nothing else in the database is ranked with them; the
// all time totals and the streak days are huge for the same reason.
let app: TestApp;
const accounts: Account[] = [];
const BASE = 3_000_000_000 + Math.floor(Math.random() * 9000) * 86_400;
const KEYS = { Day: BASE, Week: BASE + 1, Month: BASE + 2, Year: BASE + 3 };
const sync = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(token), payload: payload as object });
const totals = (day: number, allTime = 0) => ({ Day: day, Week: day * 5, Month: day * 20, Year: day * 200, 'All time': allTime });

async function person(name: string, extra: { hidden?: boolean; iso?: string } = {}) {
  const a = await createAccount(app);
  accounts.push(a);
  await app.pg.writer.query(
    `INSERT INTO userinfo (userid, dateregistered, fname, lname, iso, city, hideprofile) VALUES ($1, 1, $2, 'Walker', $3, 'Springfield', $4)`,
    [a.userid, name, extra.iso ?? 'IN', extra.hidden ?? false],
  );
  return a;
}
const rank = async (a: Account, day: number, allTime = 0, keys = KEYS) => (await sync(a.phoneToken, { up: { rank: { steps: totals(day, allTime), keys } } })).json();

beforeAll(async () => {
  app = await build();
});
afterAll(async () => {
  for (const a of accounts) {
    await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
    await a.remove();
  }
  await app.close();
});

test('the window is the user with two above and two below, four below at the top, four above at the bottom', () => {
  expect(pickWindow([1, 2, 3, 4], [5, 6, 7, 8])).toEqual({ above: [2, 1], below: [5, 6] });
  expect(pickWindow([], [5, 6, 7, 8])).toEqual({ above: [], below: [5, 6, 7, 8] });
  expect(pickWindow([1, 2, 3, 4], [])).toEqual({ above: [4, 3, 2, 1], below: [] });
  expect(pickWindow([1], [5, 6, 7, 8])).toEqual({ above: [1], below: [5, 6, 7] });
  expect(pickWindow([1, 2, 3, 4], [5])).toEqual({ above: [3, 2, 1], below: [5] });
  expect(pickWindow([], [])).toEqual({ above: [], below: [] });
});

test('the period before a day, week, month or year; none for all time', () => {
  expect(previousKey('Day', 86_400 * 10)).toBe(86_400 * 9);
  expect(previousKey('Week', 86_400 * 14)).toBe(86_400 * 7);
  expect(previousKey('Month', Date.UTC(2026, 2, 1) / 1000)).toBe(Date.UTC(2026, 1, 1) / 1000);
  expect(previousKey('Month', Date.UTC(2026, 0, 1) / 1000)).toBe(Date.UTC(2025, 11, 1) / 1000);
  expect(previousKey('Year', Date.UTC(2026, 0, 1) / 1000)).toBe(Date.UTC(2025, 0, 1) / 1000);
  expect(previousKey('All time', 0)).toBeNull();
});

test('the step ranks: a place among the public users, five people around it, a tie goes to the other, and a private user has a place that is nobody else\'s', async () => {
  const [a, b, c, d, e] = [await person('Ana', { iso: 'BR' }), await person('Ben'), await person('Cy'), await person('Di'), await person('Ed')];
  const steps = [9000, 8000, 7000, 6000, 5000];
  for (const [i, who] of [a, b, c, d, e].entries()) await rank(who, steps[i], 900_000_000 - i * 1000);

  // The middle: two above and two below, in rank order, with the user marked.
  const mid = (await rank(c, 7000, 900_000_000 - 2000)).down.rank.Day;
  expect(mid).toMatchObject({ rank: 3, of: 5 });
  expect(mid.people.map((p: { rank: number; steps: number; you?: true }) => [p.rank, p.steps, !!p.you])).toEqual([[1, 9000, false], [2, 8000, false], [3, 7000, true], [4, 6000, false], [5, 5000, false]]);
  expect(mid.people[0]).toMatchObject({ name: 'Ana Walker', place: 'Springfield, Brazil' });
  // The top has four below, the bottom four above.
  expect((await rank(a, 9000, 900_000_000)).down.rank.Day.people.map((p: { rank: number }) => p.rank)).toEqual([1, 2, 3, 4, 5]);
  expect((await rank(e, 5000, 900_000_000 - 4000)).down.rank.Day.people.map((p: { rank: number }) => p.rank)).toEqual([1, 2, 3, 4, 5]);
  // All five periods answer, and all time is ranked among the others' huge totals.
  expect(Object.keys((await rank(c, 7000, 900_000_000 - 2000)).down.rank)).toEqual(['Day', 'Week', 'Month', 'Year', 'All time']);
  expect((await rank(c, 7000, 900_000_000 - 2000)).down.rank['All time']).toMatchObject({ rank: 3 });

  // A tie goes to the person who is there first: with 7000 as well the user is fourth.
  const tie = await person('Tie');
  expect((await rank(tie, 7000)).down.rank.Day.rank).toBe(4);

  // A private user: their own place among the public ones (6500: Ana, Ben, Cy and the tie are ahead), and the people below are numbered after it. Nobody else counts them.
  const hidden = await person('Hid', { hidden: true });
  const mine = (await rank(hidden, 6500)).down.rank.Day;
  expect(mine.rank).toBe(5);
  expect(mine.people.find((p: { you?: true }) => p.you)).toMatchObject({ rank: 5, steps: 6500 });
  expect((await rank(d, 6000)).down.rank.Day.rank).toBe(5); // the private user at 6500 is not counted
  expect((await rank(d, 6000)).down.rank.Day.people.some((p: { steps: number }) => p.steps === 6500)).toBe(false);
  // Going private takes a user's rows out of everyone's board, and public brings them back.
  await app.pg.writer.query('UPDATE userinfo SET hideprofile = true WHERE userid = $1', [a.userid]);
  await setBoardsVisibility(app, a.userid, true);
  expect((await rank(b, 8000)).down.rank.Day.rank).toBe(1);
  await setBoardsVisibility(app, a.userid, false);
  expect((await rank(b, 8000)).down.rank.Day.rank).toBe(2);
});

test('the places gone up since the period before come from the row the user had then', async () => {
  const [p, q] = [await person('Pat'), await person('Quin')];
  const prev = { Day: KEYS.Day - 86_400, Week: KEYS.Week - 7 * 86_400, Month: previousKey('Month', KEYS.Month)!, Year: previousKey('Year', KEYS.Year)! };
  // Yesterday Pat was first (500) and Quin second (400); today Quin leads.
  await rank(p, 500, 0, { ...KEYS, ...prev });
  await rank(q, 400, 0, { ...KEYS, ...prev });
  const key = KEYS.Day + 86_400 * 3;
  const day = (who: Account, today: number) => sync(who.phoneToken, { up: { rank: { steps: totals(today), keys: { ...KEYS, Day: key } } } });
  await app.pg.writer.query('UPDATE step_totals SET key = $2 WHERE userid = ANY($1) AND period = 0 AND key = $3', [[p.userid, q.userid], KEYS.Day - 86_400, KEYS.Day - 86_400]);
  // Put yesterday's rows where the day before `key` is.
  await app.pg.writer.query('UPDATE step_totals SET key = $2 WHERE userid = ANY($1) AND period = 0 AND key = $3', [[p.userid, q.userid], key - 86_400, KEYS.Day - 86_400]);
  await day(p, 300);
  const reply = (await day(q, 450)).json().down.rank.Day;
  // Quin was second, is first now (450 over 300 and the earlier users' steps are on another key): up one place.
  expect(reply.rank).toBe(1);
  expect(reply.change).toBe(1);
});

test('the challengers: today\'s first eight with the user among them or added, the count, and no list while fewer than eight have steps', async () => {
  const day = BASE + 86_400 * 50;
  const many = [];
  for (let i = 0; i < 9; i++) many.push(await person(`Runner${i}`, { iso: 'GB' }));
  const send = (who: Account, steps: number, d = day) => sync(who.phoneToken, { up: { challengers: { steps, day: d } } });
  for (const [i, who] of many.entries()) await send(who, 1000 - i * 10);
  const first = (await send(many[0], 1000)).json().down.challengers;
  expect(first).toMatchObject({ rank: 1, of: 9, count: 9, iso: 'GB', country: 'United Kingdom' });
  expect(first.top).toHaveLength(8);
  expect(first.top.map((p: { rank: number }) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(first.top[0]).toMatchObject({ you: true, steps: 1000, country: 'United Kingdom', iso: 'GB' });
  // The ninth is below the eight: rank 9, and no one in the list is them.
  const last = (await send(many[8], 920)).json().down.challengers;
  expect(last).toMatchObject({ rank: 9, count: 9 });
  expect(last.top.some((p: { you?: true }) => p.you)).toBe(false);
  expect(last.top[7].steps).toBe(930);
  // A day with only three has no list.
  const early = BASE + 86_400 * 60;
  for (const who of many.slice(0, 3)) await send(who, 200, early);
  expect((await send(many[0], 200, early)).json().down.challengers).toMatchObject({ count: 3, top: [] });
  // A bad body is refused alone.
  expect((await sync(many[0].phoneToken, { up: { challengers: { steps: 'many' } } })).json().results.challengers.ok).toBe(false);
});

test('the streak leaders: the streaks running, five people around the user, a streak that ended is gone, and a user with none is last', async () => {
  const L = '9129d0f8-54c9-4ba4-a61a-0ad9169d8077';
  const START = 1_795_478_400;
  const make = (n: number, status: 'in_progress' | 'failed' = 'in_progress') => ({
    streak_id: randomUUID(), level_id: L, start_date: START, goal: 8000, status, ...(status === 'failed' ? { end_date: START + n * 86_400 } : {}),
    daily_logs: [{ level_id: L, logs: Array.from({ length: n }, () => ({ s: 9000 })) }],
  });
  const days = [3990, 3980, 3970, 3960, 3950];
  const people = [];
  const streaks: Record<number, ReturnType<typeof make>> = {};
  for (const n of days) {
    const who = await person(`Streaker${n}`, { iso: 'ES' });
    people.push(who);
    streaks[n] = make(n);
    await sync(who.phoneToken, { up: { streak: { streaks: [streaks[n]] } } });
  }
  const read = async (who: Account) => (await sync(who.phoneToken, { up: { streakLeaders: {} } })).json().down.streakLeaders;
  const mid = await read(people[2]);
  expect(mid).toMatchObject({ rank: 3 });
  expect(mid.people.map((p: { rank: number; days: number; you?: true }) => [p.rank, p.days, !!p.you])).toEqual([[1, 3990, false], [2, 3980, false], [3, 3970, true], [4, 3960, false], [5, 3950, false]]);
  expect(mid.people[0]).toMatchObject({ name: 'Streaker3990 Walker', country: 'Spain' });
  // The same days: the other is first (a tie is theirs).
  const twin = await person('Twin');
  await sync(twin.phoneToken, { up: { streak: { streaks: [make(3970)] } } });
  expect((await read(twin)).rank).toBe(4);
  // The streak that ended is off the board.
  await sync(people[0].phoneToken, { up: { streak: { streaks: [{ ...streaks[3990], status: 'failed', end_date: START + 3990 * 86_400 }] } } });
  expect((await read(people[1])).rank).toBe(1);
  // A user with no streak is after everyone, with no days.
  const none = await person('None');
  const last = await read(none);
  expect(last.people.at(-1)).toMatchObject({ you: true, days: 0, rank: last.rank });
  expect(last.people).toHaveLength(5);
  // A private user is left out of the others' board.
  const secret = await person('Secret', { hidden: true });
  await sync(secret.phoneToken, { up: { streak: { streaks: [make(3999)] } } });
  expect((await read(people[1])).rank).toBe(1);
});
