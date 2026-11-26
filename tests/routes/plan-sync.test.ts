import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { mergeWeeks } from '../../src/services/plan/runPlan.js';

// The plan section of the unified call (docs/data/sync.md section 4h): the running plan as one row of run_plans, written so that an older phone can never change what a newer one wrote. Its own file: the sync tests
// together make more requests than the rate limit allows in a minute.
let app: TestApp;
let c: Account;
const sync = (payload: unknown, token = c.phoneToken) => app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(token), payload: payload as object });
const START = 1_795_478_400;
const W1 = [1, 'o', '-.R.R.L'] as const;
const W2 = [2, 'o', '..R.r.L'] as const;
const W3 = [3, 'r', '..R.r.l'] as const;

const plan = (id: string, over: Record<string, unknown> = {}) => ({
  plan_id: id, started_on: START, longest_run: 1, distance: 2, gen: 1, total_weeks: 19, run_days: 84, long_day: 6, pace_delta: 0, volume_pm: 0, settings_at: 100, weeks_from: 0, weeks: [], ...over,
});
const send = (p: unknown, token = c.phoneToken) => sync({ up: { plan: { plan: p } } }, token);
const row = async (id: string) => (await app.pg.writer.query('SELECT * FROM run_plans WHERE plan_id = $1', [id])).rows[0];

beforeAll(async () => {
  app = await build();
  c = await createAccount(app);
});
afterAll(async () => {
  await c.remove();
  await app.close();
});

test('the weeks a plan holds only grow: what is held is never changed, and a gap is left out', () => {
  expect(mergeWeeks([], 0, [W1 as never])).toEqual([W1]);
  // The phone sends from the start again: only the new week is added.
  expect(mergeWeeks([W1 as never], 0, [W1 as never, W2 as never])).toEqual([W1, W2]);
  // A different week 1 (an older or wrong phone) changes nothing.
  expect(mergeWeeks([W1 as never, W2 as never], 0, [W3 as never])).toEqual([W1, W2]);
  // Nothing in between: left out, the answer says how many are held.
  expect(mergeWeeks([W1 as never], 3, [W3 as never])).toEqual([W1]);
});

test('a plan is stored with its weeks, and sending it again changes nothing', async () => {
  const id = randomUUID();
  const res = await send(plan(id, { weeks: [W1, W2] }));
  expect(res.json().results.plan).toEqual({ ok: true, weeks: 2 });
  const r = await row(id);
  expect(r).toMatchObject({ userid: c.userid, longest_run: 1, distance: 2, gen: 1, total_weeks: 19, run_days: 84, long_day: 6, ended_on: null });
  expect(Number(r.started_on)).toBe(START);
  expect(r.weeks).toEqual([W1, W2]);
  // Again, and with a week more: the held weeks stay, the new one is added.
  expect((await send(plan(id, { weeks: [W1, W2] }))).json().results.plan).toEqual({ ok: true, weeks: 2 });
  expect((await send(plan(id, { weeks_from: 2, weeks: [W3] }))).json().results.plan).toEqual({ ok: true, weeks: 3 });
  expect((await row(id)).weeks).toEqual([W1, W2, W3]);
  // A phone that is behind sends a different first week: nothing changes.
  await send(plan(id, { weeks: [W3] }));
  expect((await row(id)).weeks).toEqual([W1, W2, W3]);
  // A phone that is ahead of what the server holds (a gap) is told how many weeks it has.
  expect((await send(plan(id, { weeks_from: 9, weeks: [W3] }))).json().results.plan).toEqual({ ok: true, weeks: 3 });
});

test('the run days, tuning and pause go to the latest change; the plan\'s identity and its end are written once', async () => {
  const id = randomUUID();
  await send(plan(id));
  await send(plan(id, { run_days: 42, long_day: 4, pace_delta: 15, volume_pm: 50, tuned_from_week: 4, paused_until: START + 604_800, settings_at: 200 }));
  expect(await row(id)).toMatchObject({ run_days: 42, long_day: 4, pace_delta: 15, volume_pm: 50, tuned_from_week: 4, settings_at: '200' });
  // An older change (a phone restored from a backup) does not win.
  await send(plan(id, { run_days: 84, pace_delta: 0, settings_at: 150 }));
  expect(await row(id)).toMatchObject({ run_days: 42, pace_delta: 15, settings_at: '200' });
  // The answers cannot be changed after the start.
  await send(plan(id, { longest_run: 3, distance: 0, gen: 9, total_weeks: 5, settings_at: 300 }));
  expect(await row(id)).toMatchObject({ longest_run: 1, distance: 2, gen: 1, total_weeks: 19 });
  // The end is written once.
  await send(plan(id, { ended_on: START + 86_400, settings_at: 300 }));
  await send(plan(id, { ended_on: START + 999_999, settings_at: 300 }));
  expect(Number((await row(id)).ended_on)).toBe(START + 86_400);
});

test('a new plan ends the one still running, and the restore gives the running plan, else the latest that ended', async () => {
  const mine = await createAccount(app);
  const a = randomUUID();
  const b = randomUUID();
  expect((await sync({ restore: { plan: true } }, mine.phoneToken)).json().down.restore.plan).toEqual({ current: null });
  await send(plan(a, { weeks: [W1] }), mine.phoneToken);
  await send(plan(b, { started_on: START + 8 * 86_400 }), mine.phoneToken);
  const ended = (await app.pg.writer.query('SELECT plan_id, ended_on FROM run_plans WHERE userid = $1 ORDER BY started_on', [mine.userid])).rows;
  expect(Number(ended[0].ended_on)).toBe(START + 8 * 86_400);
  expect(ended[1].ended_on).toBeNull();
  const running = (await sync({ restore: { plan: true } }, mine.phoneToken)).json().down.restore.plan.current;
  expect(running).toMatchObject({ plan_id: b, started_on: START + 8 * 86_400, ended_on: null, run_days: 84, weeks: [] });
  // The running plan ends: the latest that ended comes back, with its days.
  await send(plan(b, { started_on: START + 8 * 86_400, ended_on: START + 20 * 86_400, settings_at: 500 }), mine.phoneToken);
  const last = (await sync({ restore: { plan: true } }, mine.phoneToken)).json().down.restore.plan.current;
  expect(last).toMatchObject({ plan_id: b, ended_on: START + 20 * 86_400 });
  await mine.remove();
});

test('a plan id that is another user\'s is refused and left as it was, and a bad body is refused alone', async () => {
  const other = await createAccount(app);
  const id = randomUUID();
  await send(plan(id, { weeks: [W1] }), other.phoneToken);
  const res = await send(plan(id, { weeks: [W2], run_days: 1, settings_at: 999 }));
  expect(res.json().results.plan).toMatchObject({ ok: false, refused: [id] });
  expect(await row(id)).toMatchObject({ userid: other.userid, run_days: 84 });
  const bad = await send(plan(randomUUID(), { weeks: [[1, 'x', 'nope']] }));
  expect(bad.json().results.plan.ok).toBe(false);
  await other.remove();
});
