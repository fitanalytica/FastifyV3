import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';

// The streak section of the unified call (docs/data/sync.md section 4g): the streak stored as streak_logs, and its protection ledger (services/streak/ledger.ts) written with it. Its own file: the sync tests
// together make more requests than the rate limit allows in a minute.
let app: TestApp;
let c: Account;
const sync = (payload: unknown, token = c.phoneToken) => app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(token), payload: payload as object });
const L0 = '9129d0f8-54c9-4ba4-a61a-0ad9169d8077';
const L1 = '04de35bc-2808-4ba1-8289-33b22e2632e0';
const START = 1795478400;

beforeAll(async () => {
  app = await build();
  c = await createAccount(app);
});
afterAll(async () => {
  await c.remove();
  await app.close();
});

test('a streak is stored as streak_logs, with the days worked out by the server, and a bad body is refused alone', async () => {
  const id = randomUUID();
  const streak = (over: Record<string, unknown> = {}) => ({
    streak_id: id, level_id: L0, start_date: START, goal: 8000, status: 'in_progress',
    daily_logs: [{ level_id: L0, logs: [{ s: 9000 }, { s: 100, r: 5, r_t: 30, p: true }, { s: 0, n: true }, { s: 8100, r: 25, r_t: 30 }] }],
    ...over,
  });
  const res = await sync({ up: { streak: { streaks: [streak()] } } });
  expect(res.json().results.streak).toEqual({ ok: true });
  const row = (await app.pg.writer.query('SELECT * FROM streak_logs WHERE streak_id = $1', [id])).rows[0];
  // Two valid days (the protected day and the day with no data do not count), one protection day used.
  expect(row).toMatchObject({ userid: c.userid, goal: 8000, duration: 2, protection_used: 1, status: 'in_progress' });
  expect(Number(row.start_date)).toBe(START);
  expect(row.daily_logs[0].logs[1]).toEqual({ s: 100, r: 5, r_t: 30, p: true });
  expect(row.daily_logs[0].logs[2]).toEqual({ s: 0, n: true });
  // The same streak sent again as it ended: updated, not added.
  await sync({ up: { streak: { streaks: [streak({ status: 'failed', end_date: START + 172800 })] } } });
  const again = (await app.pg.writer.query('SELECT status, end_date FROM streak_logs WHERE streak_id = $1', [id])).rows;
  expect(again).toHaveLength(1);
  expect(again[0]).toMatchObject({ status: 'failed' });
  expect(Number(again[0].end_date)).toBe(START + 172800);
  const bad = await sync({ up: { streak: { streaks: [streak({ goal: 5 })] } } });
  expect(bad.json().results.streak).toMatchObject({ ok: false });
  await app.pg.writer.query('DELETE FROM streak_logs WHERE streak_id = $1', [id]);
});

test('its protection ledger is written with it from its days, replaced when it changes, and a purchase is never touched; the balance is the sum', async () => {
  const id = randomUUID();
  const body = (logs: unknown[]) => ({ streak_id: id, level_id: L1, start_date: START, goal: 8000, status: 'in_progress', daily_logs: logs });
  await app.pg.writer.query(`INSERT INTO protection_logs (userid, protection_days, transaction_type, transaction_id) VALUES ($1, 25, 'iap', $2)`, [c.userid, 9_000_000_000 + Math.floor(Math.random() * 1e6)]);
  const rows = async () => (await app.pg.writer.query(`SELECT transaction_type AS t, protection_days AS d, level_id, dtgraph FROM protection_logs WHERE streak_id = $1 ORDER BY dtgraph, transaction_type`, [id])).rows;
  const balance = async () => Number((await app.pg.writer.query('SELECT sum(protection_days) AS b FROM protection_logs WHERE userid = $1', [c.userid])).rows[0].b);
  const first = [{ level_id: L0, logs: [{ s: 9000 }, { s: 9000 }, { s: 100, p: true }] }];
  // Two kept days (Beginner pays 2), then a protected day.
  await sync({ up: { streak: { streaks: [body(first)] } } });
  expect(await rows()).toEqual([
    { t: 'grant', d: 2, level_id: L0, dtgraph: String(START + 86400) },
    { t: 'consume', d: -1, level_id: L0, dtgraph: String(START + 2 * 86400) },
  ]);
  expect(await balance()).toBe(25 + 2 - 1);
  // Sent again as it is: the same rows, not more.
  await sync({ up: { streak: { streaks: [body(first)] } } });
  expect(await rows()).toHaveLength(2);
  // It grows: seven valid days pay Contender too; the purchase is still there.
  await sync({ up: { streak: { streaks: [body([...first, { level_id: L1, logs: Array.from({ length: 5 }, () => ({ s: 9000 })) }])] } } });
  expect((await rows()).map((r: { t: string; d: number }) => [r.t, r.d])).toEqual([['grant', 2], ['consume', -1], ['grant', 2]]);
  expect(await balance()).toBe(25 + 2 - 1 + 2);
  // The streak goes, and its rows with it (they belong to it); the purchase stays.
  await app.pg.writer.query('DELETE FROM streak_logs WHERE streak_id = $1', [id]);
  expect(await balance()).toBe(25);
  await app.pg.writer.query('DELETE FROM protection_logs WHERE userid = $1', [c.userid]);
});

test('a streak the old app wrote keeps its ledger rows exactly as they are, and only what is missing is added', async () => {
  const id = randomUUID();
  const body = (logs: unknown[]) => ({ streak_id: id, level_id: L1, start_date: START, goal: 8000, status: 'in_progress', daily_logs: logs });
  // The old app's streak and rows: a grant for Beginner, a consume for day 3 (its own level and times), and a consume for day 4 that was lifted later (the day is not protected in the days).
  await app.pg.writer.query(`INSERT INTO streak_logs (streak_id, userid, level_id, start_date, goal, duration, status, protection_used, daily_logs) VALUES ($1, $2, $3, $4, 8000, 2, 'in_progress', 1, '[]')`, [id, c.userid, L1, START]);
  const old = (type: string, days: number, level: string, dtgraph: number, ddate: number) =>
    app.pg.writer.query(`INSERT INTO protection_logs (streak_id, level_id, userid, dtgraph, protection_days, transaction_type, ddate) VALUES ($1, $2, $3, $4, $5, $6::protection_logs_transaction_type_enum, $7)`, [id, level, c.userid, dtgraph, days, type, ddate]);
  await old('grant', 2, L0, START + 86400, 1700000001);
  await old('consume', -1, L1, START + 2 * 86400, 1700000002);
  await old('consume', -1, L1, START + 3 * 86400, 1700000003);
  const ledger = async () => (await app.pg.writer.query('SELECT transaction_type AS t, protection_days AS d, dtgraph, ddate FROM protection_logs WHERE streak_id = $1 ORDER BY dtgraph, transaction_type', [id])).rows;
  const before = await ledger();
  // The phone sends the streak: 2 kept days, a protected day (day 3), a kept day 4 (the lifted one), then three more kept days: Contender (7 valid days) is new.
  const days = [{ level_id: L0, logs: [{ s: 9000 }, { s: 9000 }, { s: 100, p: true }] }, { level_id: L1, logs: Array.from({ length: 5 }, () => ({ s: 9000 })) }];
  await sync({ up: { streak: { streaks: [body(days)] } } });
  const after = await ledger();
  // Every old row is still there, unchanged (the lifted day's consume too: it was what the user was charged), and only the grant for Contender was added.
  for (const row of before) expect(after).toContainEqual(row);
  expect(after).toHaveLength(before.length + 1);
  expect(after.filter((r: { t: string }) => r.t === 'grant').map((r: { d: number }) => r.d)).toEqual([2, 2]);
  // Sent again: nothing more.
  await sync({ up: { streak: { streaks: [body(days)] } } });
  expect(await ledger()).toEqual(after);
  await app.pg.writer.query('DELETE FROM streak_logs WHERE streak_id = $1', [id]);
});

test('days the server already held are settled: an old streak whose reward the old app never granted is not credited, and only new days produce events', async () => {
  const id = randomUUID();
  const body = (logs: unknown[]) => ({ streak_id: id, level_id: L1, start_date: START, goal: 8000, status: 'failed', end_date: START + 2 * 86400, daily_logs: logs });
  // The old app's streak: two kept days (Beginner reached) and it failed, with no grant row: its days are already stored.
  const held = [{ level_id: L0, logs: [{ s: 9000 }, { s: 9000 }] }];
  await app.pg.writer.query(`INSERT INTO streak_logs (streak_id, userid, level_id, start_date, end_date, goal, duration, status, protection_used, daily_logs) VALUES ($1, $2, $3, $4, $5, 8000, 2, 'failed', 0, $6::jsonb)`, [id, c.userid, L0, START, START + 2 * 86400, JSON.stringify(held)]);
  const count = async () => (await app.pg.writer.query('SELECT count(*)::int AS n FROM protection_logs WHERE streak_id = $1', [id])).rows[0].n;
  // The phone sends it back as it is: nothing is derived for days the server holds, so the Beginner reward is not paid after the fact.
  await sync({ up: { streak: { streaks: [body(held)] } } });
  expect(await count()).toBe(0);
  // The streak is carried on with five more kept days (seven valid: Contender): only those days make events.
  const more = [...held, { level_id: L1, logs: Array.from({ length: 5 }, () => ({ s: 9000 })) }];
  await sync({ up: { streak: { streaks: [{ ...body(more), status: 'in_progress', end_date: undefined }] } } });
  const rows = (await app.pg.writer.query('SELECT transaction_type AS t, protection_days AS d, dtgraph FROM protection_logs WHERE streak_id = $1', [id])).rows;
  expect(rows).toEqual([{ t: 'grant', d: 2, dtgraph: String(START + 6 * 86400) }]);
  await app.pg.writer.query('DELETE FROM streak_logs WHERE streak_id = $1', [id]);
});

test('the restore gives the streak to carry on, the earlier ones as lines, and the protection earned and not spent (not what was bought)', async () => {
  const mine = await createAccount(app);
  const running = randomUUID(), ended = randomUUID(), older = randomUUID();
  const day = 86400;
  const streak = (id: string, start: number, end: number | null, status: string, duration: number, logs: unknown[]) =>
    app.pg.writer.query(`INSERT INTO streak_logs (streak_id, userid, level_id, start_date, end_date, goal, duration, status, protection_used, daily_logs) VALUES ($1, $2, $3, $4, $5, 8000, $6, $7::streak_status, 1, $8::jsonb)`, [id, mine.userid, L1, start, end, duration, status, JSON.stringify(logs)]);
  await streak(older, START - 40 * day, START - 30 * day, 'failed', 4, [{ level_id: L0, logs: [{ s: 9000 }, { s: 9000 }, { s: 9000 }, { s: 9000 }, { s: 10 }] }]);
  await streak(ended, START - 20 * day, START - 10 * day, 'failed', 2, [{ level_id: L0, logs: [{ s: 9000 }, { s: 9000 }, { s: 5 }] }]);
  await streak(running, START, null, 'in_progress', 3, [{ level_id: L0, logs: [{ s: 9000 }, { s: 100, p: true }, { s: 9000 }, { s: 9000 }] }]);
  const ledger = (type: string, days: number, streakId: string | null) => app.pg.writer.query(`INSERT INTO protection_logs (userid, streak_id, level_id, dtgraph, protection_days, transaction_type, transaction_id) VALUES ($1, $2, $3, $4, $5, $6::protection_logs_transaction_type_enum, $7)`, [mine.userid, streakId, streakId ? L0 : null, streakId ? START : null, days, type, type === 'iap' ? 9_100_000_000 + Math.floor(Math.random() * 1e6) : null]);
  await ledger('grant', 2, running);
  await ledger('consume', -1, running);
  await ledger('grant', 2, ended);
  await ledger('iap', 25, null);
  const res = await sync({ restore: { streak: true } }, mine.phoneToken);
  expect(res.json().results.restore).toEqual({ ok: true });
  const down = res.json().down.restore.streak;
  expect(down.current).toMatchObject({ streak_id: running, status: 'in_progress', goal: 8000, start_date: START, end_date: null, duration: 3 });
  expect(down.current.daily_logs[0].logs).toHaveLength(4);
  expect(down.past.map((p: { streak_id: string; duration: number }) => [p.streak_id, p.duration])).toEqual([[ended, 2], [older, 4]]);
  // The earlier streaks bring their days (the calendar shows them), with their status and goal.
  expect(down.past[0]).toMatchObject({ status: 'failed', goal: 8000 });
  expect(down.past[0].daily_logs[0].logs).toHaveLength(3);
  // 2 + 2 - 1: what was earned and spent; the 25 bought are the store state's.
  expect(down.balance).toBe(3);
  // Without the ask it is not sent; for a user who never had a streak there is nothing.
  expect((await sync({ restore: { walk: true } }, mine.phoneToken)).json().down.restore.streak).toBeUndefined();
  const none = (await sync({ restore: { streak: true } })).json().down.restore.streak;
  expect(none).toEqual({ current: null, past: [], balance: 0 });
  // The newest that ended is the one to carry on when none is running.
  await app.pg.writer.query(`UPDATE streak_logs SET status = 'failed', end_date = $2 WHERE streak_id = $1`, [running, START + 3 * day]);
  const after = (await sync({ restore: { streak: true } }, mine.phoneToken)).json().down.restore.streak;
  expect(after.current.streak_id).toBe(running);
  expect(after.current.status).toBe('failed');
  await mine.remove();
});

test('a streak id that is another user’s is refused and left as it was, with no ledger rows written', async () => {
  const other = await createAccount(app);
  const id = randomUUID();
  const body = (goal: number, logs: unknown[]) => ({ streak_id: id, level_id: L0, start_date: START, goal, status: 'in_progress', daily_logs: logs });
  await sync({ up: { streak: { streaks: [body(8000, [])] } } }, other.phoneToken);
  const res = await sync({ up: { streak: { streaks: [body(9000, [{ level_id: L0, logs: [{ s: 9000 }, { s: 9000 }] }])] } } });
  expect(res.json().results.streak).toMatchObject({ ok: false, refused: [id] });
  expect((await app.pg.writer.query('SELECT goal FROM streak_logs WHERE streak_id = $1', [id])).rows[0].goal).toBe(8000);
  expect((await app.pg.writer.query('SELECT count(*)::int AS n FROM protection_logs WHERE streak_id = $1', [id])).rows[0].n).toBe(0);
  await app.pg.writer.query('DELETE FROM streak_logs WHERE streak_id = $1', [id]);
  await other.remove();
});
