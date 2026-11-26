import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { currentRanges, periodRange, readDistanceRank, rebuildDistanceTotals } from '../../src/services/leaderboard/distanceTotals.js';
import { setBoardsVisibility } from '../../src/services/leaderboard/stepTotals.js';

// The distance leaderboard (docs/data/sync.md section 4i): made by the server from the activities table. The activities are in the year 2037, so nothing else in the database is in the same periods; the "now" is a day of that week.
let app: TestApp;
const accounts: Account[] = [];
const DAY = 86_400;
// A Wednesday of June 2037 (the columns are 32-bit seconds: nothing later fits).
const WED = (() => {
  const d = new Date(Date.UTC(2037, 5, 10));
  return (Date.UTC(2037, 5, 10) + ((3 - d.getUTCDay() + 7) % 7) * 86_400_000) / 1000;
})();
const NOW = WED + 12 * 3600;
const keys = { Day: 0, Week: periodRange('Week', WED).key, Month: periodRange('Month', WED).key, Year: periodRange('Year', WED).key };

async function runner(name: string, hidden = false) {
  const a = await createAccount(app);
  accounts.push(a);
  await app.pg.writer.query(`INSERT INTO userinfo (userid, dateregistered, fname, lname, iso, city, hideprofile) VALUES ($1, 1, $2, 'Runner', 'IN', 'Pune', $3)`, [a.userid, name, hidden]);
  return a;
}
const activity = (a: Account, day: number, metres: number, tosend = 1) =>
  app.pg.writer.query(
    `INSERT INTO activities (activityid, userid, downloadid, startdate, enddate, dtgraph, distance, duration, tosend, geom) VALUES ($1, $2, $3, $4, $4, $5, $6, 600, $7, point(0, 0))`,
    [randomUUID(), a.userid, a.phoneDownloadid, day + 8 * 3600, day, metres, tosend],
  );

beforeAll(async () => {
  app = await build();
});
afterAll(async () => {
  for (const a of accounts) {
    await app.pg.writer.query('DELETE FROM activities WHERE userid = $1', [a.userid]);
    await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
    await a.remove();
  }
  await app.pg.writer.query(`DELETE FROM leaderboard_runs WHERE name LIKE 'distance:%' AND at >= ${NOW}`);
  await app.close();
});

test('the week, month and year that hold a day, and the periods kept current', () => {
  expect(periodRange('Week', WED)).toEqual({ key: WED - 2 * DAY, end: WED + 5 * DAY });
  expect(periodRange('Month', WED)).toEqual({ key: Date.UTC(2037, 5, 1) / 1000, end: Date.UTC(2037, 6, 1) / 1000 });
  expect(periodRange('Year', WED)).toEqual({ key: Date.UTC(2037, 0, 1) / 1000, end: Date.UTC(2038, 0, 1) / 1000 });
  expect(periodRange('All time', WED)).toEqual({ key: 0, end: null });
  const ranges = currentRanges(NOW);
  // The current period of each kind and the one before, and all time once.
  expect(ranges.filter(r => r.period === 'Week').map(r => r.key)).toEqual(expect.arrayContaining([keys.Week, keys.Week - 7 * DAY]));
  expect(ranges.filter(r => r.period === 'All time')).toHaveLength(1);
  expect(new Set(ranges.map(r => `${r.index}:${r.key}`)).size).toBe(ranges.length);
});

test('the ranks come from the activities: a deleted one does not count, a tie goes to the other, a private user has their own place, and the places gone up are against the week before', async () => {
  const [a, b, c, d, e] = [await runner('Ana'), await runner('Ben'), await runner('Cy'), await runner('Di', true), await runner('Ed')];
  await activity(a, WED, 3000);
  await activity(a, WED - DAY, 1000); // the same week (Tuesday): 4000
  await activity(b, WED, 2000);
  await activity(c, WED, 1000);
  await activity(c, WED, 9000, 0); // deleted: not counted
  await activity(c, WED - 7 * DAY, 9000); // the week before: Cy led it
  await activity(d, WED, 2500);
  await activity(e, WED, 2000); // the same as Ben

  const week = (await readDistanceRank(app, a.userid, keys, NOW)).Week;
  // Four public users have distance this week (the private one is not counted for them).
  expect(week).toMatchObject({ rank: 1, of: 4 });
  expect(week.people.find(p => p.you)).toMatchObject({ distance: 4000 });
  // Ben and Ed have 2000: a tie goes to the other person, so each of them is behind the other (both third); the private Di is not in anyone's list.
  const ben = (await readDistanceRank(app, b.userid, keys, NOW)).Week;
  const ed = (await readDistanceRank(app, e.userid, keys, NOW)).Week;
  expect([ben.rank, ed.rank]).toEqual([3, 3]);
  expect(ben.people.some(p => p.distance === 2500)).toBe(false);
  // Di is private: their own place among the public ones (behind Ana, ahead of Ben and Ed), and Cy: only 1000 counts.
  const di = (await readDistanceRank(app, d.userid, keys, NOW)).Week;
  expect(di.rank).toBe(2);
  expect(di.of).toBe(5);
  expect(di.people.find(p => p.you)).toMatchObject({ distance: 2500, rank: 2 });
  const cy = await readDistanceRank(app, c.userid, keys, NOW);
  expect(cy.Week.rank).toBe(4);
  expect(cy.Week.people.find(p => p.you)).toMatchObject({ distance: 1000 });
  // Last week Cy had 9000 and led: three places down now.
  expect(cy.Week.change).toBe(-3);
  // The month and the year hold both weeks.
  expect(cy.Month.people.find(p => p.you)).toMatchObject({ distance: 10000 });
  expect(cy.Year.people.find(p => p.you)).toMatchObject({ distance: 10000 });
  // All time is answered too, with the user's own total in it.
  expect(cy['All time'].people.find(p => p.you)?.distance).toBeGreaterThanOrEqual(10000);
  expect(week.people[0]).toMatchObject({ name: expect.any(String), place: expect.any(String) });

  // Going private takes the rows out of everyone's board; public brings them back.
  await app.pg.writer.query('UPDATE userinfo SET hideprofile = true WHERE userid = $1', [a.userid]);
  await setBoardsVisibility(app, a.userid, true);
  expect((await readDistanceRank(app, b.userid, keys, NOW)).Week.rank).toBe(2);
  await setBoardsVisibility(app, a.userid, false);
  await app.pg.writer.query('UPDATE userinfo SET hideprofile = false WHERE userid = $1', [a.userid]);
  expect((await readDistanceRank(app, b.userid, keys, NOW)).Week.rank).toBe(3);
});

test('the rebuild is not repeated within its time, and an activity deleted since is taken out when it is', async () => {
  const x = await runner('Xan');
  await activity(x, WED, 500);
  const later = NOW + 3 * 3600;
  await rebuildDistanceTotals(app, later);
  const row = async () => (await app.pg.writer.query(`SELECT distance_m FROM distance_totals WHERE userid = $1 AND period = 1 AND key = $2`, [x.userid, keys.Week])).rows[0];
  expect(Number((await row()).distance_m)).toBe(500);
  await app.pg.writer.query('UPDATE activities SET tosend = 0 WHERE userid = $1', [x.userid]);
  // Within the ten minutes: nothing rebuilt, the old figure stays.
  expect(await rebuildDistanceTotals(app, later + 60)).toBe(0);
  expect(Number((await row()).distance_m)).toBe(500);
  // After: the user has no distance this week, so the row goes.
  await rebuildDistanceTotals(app, later + 700);
  expect(await row()).toBeUndefined();
});

test('the section answers in a sync call, and a bad request is refused alone', async () => {
  const y = await runner('Yan');
  await activity(y, WED, 1200);
  const ok = await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(y.phoneToken), payload: { up: { distanceRank: { keys: { Week: keys.Week, Month: keys.Month, Year: keys.Year } }, device: {} } } });
  expect(ok.json().results.distanceRank).toEqual({ ok: true });
  expect(Object.keys(ok.json().down.distanceRank)).toEqual(['Week', 'Month', 'Year', 'All time']);
  const bad = await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(y.phoneToken), payload: { up: { distanceRank: { keys: { Week: 'x' } } } } });
  expect(bad.json().results.distanceRank.ok).toBe(false);
  expect(bad.json().down.distanceRank).toBeUndefined();
});
