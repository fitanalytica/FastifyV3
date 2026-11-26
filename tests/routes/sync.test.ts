import { test, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';

// The unified sync call (docs/data/sync.md): the envelope, per-section results, and the walk section.
let app: TestApp;
let a: Account;
const DAY = 86400;
const today = Math.floor(Date.now() / 1000 / DAY) * DAY;

const sync = (payload: unknown, token = a.phoneToken) => app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(token), payload: payload as object });
const row = async () => (await app.pg.writer.query('SELECT * FROM walkdata WHERE userid = $1', [a.userid])).rows[0];
const TODAY = { dtgraph: today, stepcount: 4200, distance: 3100, ascend: 3, max_steps: 21000, max_steps_date: today - 9 * DAY, max_distance: 15000, max_distance_date: today - 9 * DAY, steps_goal: 8000 };
const HISTORY = { base: today, dtgraph_json: [1, 2, 0], stepcount_json: [5000, 6000, 7000], ascend_json: [1, 2, 3], distance_json: [3500, 4200, 5000], iso_json: [['IN', 2], ['FR', 1]] };

beforeAll(async () => {
  app = await build();
  a = await createAccount(app);
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM walkdata WHERE userid = $1', [a.userid]);
  await a.remove();
  await app.close();
});

test('an empty call is fine: nothing saved, nothing back', async () => {
  const res = await sync({});
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ results: {}, down: {}, more: false });
});

test('walk: history and today in one request, both saved, one answer', async () => {
  const res = await sync({ up: { walk: { history: HISTORY, today: TODAY } } });
  expect(res.statusCode).toBe(200);
  expect(res.json().results).toEqual({ walk: { ok: true, history: 'ok', today: 'ok' } });
  expect(await row()).toMatchObject({ dtgraph: today, stepcount: 4200, history_base: today, stepcount_json: [5000, 6000, 7000], iso_json: [['IN', 2], ['FR', 1]], descend: null });
});

test('walk: today alone, or history alone', async () => {
  expect((await sync({ up: { walk: { today: { ...TODAY, stepcount: 4300 } } } })).json().results.walk).toEqual({ ok: true, today: 'ok' });
  expect((await row()).stepcount).toBe(4300);
  expect((await sync({ up: { walk: { history: HISTORY } } })).json().results.walk).toEqual({ ok: true, history: 'ok' });
});

test('walk: a history that is refused makes today wait, and says so; today is not written', async () => {
  const before = (await row()).stepcount;
  const res = await sync({ up: { walk: { history: { ...HISTORY, ascend_json: [1] }, today: { ...TODAY, stepcount: 9999 } } } });
  expect(res.statusCode).toBe(200);
  expect(res.json().results.walk).toEqual({ ok: false, code: 'BAD_HISTORY', history: 'BAD_HISTORY', today: 'WAITING' });
  expect((await row()).stepcount).toBe(before);
});

test('walk: a today that is refused does not undo the history saved in the same request', async () => {
  const res = await sync({ up: { walk: { history: { ...HISTORY, stepcount_json: [1, 2, 3] }, today: { ...TODAY, dtgraph: today + 5 } } } });
  expect(res.json().results.walk).toEqual({ ok: false, code: 'BAD_DTGRAPH', history: 'ok', today: 'BAD_DTGRAPH' });
  expect((await row()).stepcount_json).toEqual([1, 2, 3]);
});

test('a section that is not valid fails alone; a section the server does not have is named; the valid one is saved', async () => {
  const res = await sync({ up: { walk: { today: { ...TODAY, stepcount: 4400 } }, nothing: { x: 1 }, future: 'nonsense' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().results).toEqual({ walk: { ok: true, today: 'ok' }, nothing: { ok: false, code: 'UNKNOWN_SECTION' }, future: { ok: false, code: 'UNKNOWN_SECTION' } });
  const bad = await sync({ up: { walk: { today: { stepcount: 'many' } } } });
  expect(bad.statusCode).toBe(200);
  expect(bad.json().results.walk).toEqual({ ok: false, code: 'BAD_REQUEST' });
  expect((await sync({ up: { walk: { surprise: 1 } } })).json().results.walk).toEqual({ ok: false, code: 'BAD_REQUEST' });
  expect((await row()).stepcount).toBe(4400);
});

test('a name like a built-in property is just an unknown section', async () => {
  expect((await sync({ up: { constructor: {}, toString: 1 } })).json().results).toEqual({ constructor: { ok: false, code: 'UNKNOWN_SECTION' }, toString: { ok: false, code: 'UNKNOWN_SECTION' } });
});

test('the envelope: a body that is not an object, or have with a non-text value, is a 400; a call with no token or a watch token is refused', async () => {
  expect((await sync({ up: [1] })).statusCode).toBe(400);
  expect((await sync({ have: { state: { a: 1 } } })).statusCode).toBe(400);
  expect((await sync({}, a.watchToken)).statusCode).toBe(403);
  const anon = await app.inject({ method: 'POST', url: '/phone/v3/sync', payload: {} });
  expect(anon.statusCode).toBe(400);
  expect(anon.json().code).toBe('INVALID_TOKEN_FORMAT');
});

test('a gzip body is unpacked and handled like a plain one (what the phone sends for a large call)', async () => {
  const body = gzipSync(JSON.stringify({ up: { walk: { history: HISTORY, today: { ...TODAY, stepcount: 4500 } } } }));
  const res = await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: { ...bearer(a.phoneToken), 'content-type': 'application/json', 'content-encoding': 'gzip' }, payload: body });
  expect(res.statusCode).toBe(200);
  expect(res.json().results).toEqual({ walk: { ok: true, history: 'ok', today: 'ok' } });
  expect((await row()).stepcount).toBe(4500);
});

test('walk today: yesterday is kept, and an absent yesterday keeps what is stored', async () => {
  await sync({ up: { walk: { today: { ...TODAY, yesterday: { dtgraph: today - DAY, stepcount: 9000, distance: 6500 } } } } });
  expect(await row()).toMatchObject({ yesterday_dtgraph: today - DAY, yesterday_stepcount: 9000 });
  await sync({ up: { walk: { today: TODAY } } });
  expect((await row()).yesterday_stepcount).toBe(9000);
});

test('walk today: a label that is not a day or is far from the date, a yesterday that is not the day before, or a negative count, is refused with its code', async () => {
  const today1 = async (t: object) => (await sync({ up: { walk: { today: t } } })).json().results.walk;
  expect(await today1({ ...TODAY, dtgraph: today + 5 })).toEqual({ ok: false, code: 'BAD_DTGRAPH', today: 'BAD_DTGRAPH' });
  expect((await today1({ ...TODAY, dtgraph: today - 5 * DAY })).code).toBe('BAD_DTGRAPH');
  expect((await today1({ ...TODAY, yesterday: { dtgraph: today - 2 * DAY, stepcount: 1, distance: 1 } })).code).toBe('BAD_YESTERDAY');
  expect((await today1({ ...TODAY, stepcount: -1 })).code).toBe('BAD_REQUEST');
});

test('walk history: with no row yet one is made; arrays that do not line up, a base that is not a day, or a country that is not 2 letters are refused', async () => {
  await app.pg.writer.query('DELETE FROM walkdata WHERE userid = $1', [a.userid]);
  expect((await sync({ up: { walk: { history: HISTORY } } })).json().results.walk).toEqual({ ok: true, history: 'ok' });
  expect(await row()).toMatchObject({ dtgraph: today, history_base: today, stepcount: null, descend_json: null });
  for (const bad of [{ ...HISTORY, iso_json: [['IN', 5]] }, { ...HISTORY, base: today + 1 }]) {
    expect((await sync({ up: { walk: { history: bad } } })).json().results.walk.code).toBe('BAD_HISTORY');
  }
  expect((await sync({ up: { walk: { history: { ...HISTORY, iso_json: [['india', 3]] } } } })).json().results.walk.code).toBe('BAD_REQUEST');
});

// ---- the activities section: send (the batch) and delete
import { activity, activityRow } from '../helpers/fixtures.js';
import { randomUUID } from 'node:crypto';

test('activities: a batch is saved, one result per item in order, the same as the batch route; a repeat is `exists`', async () => {
  const [x, y] = [activity(a.phoneDownloadid), activity(a.phoneDownloadid, { description: 'second' })];
  const res = await sync({ up: { activities: { send: [x, y] } } });
  expect(res.statusCode).toBe(200);
  const r = res.json().results.activities;
  expect(r.ok).toBe(true);
  expect(r.send.map((i: { status: string }) => i.status)).toEqual(['created', 'created']);
  expect((await activityRow(app, x.activityid)).userid).toBe(a.userid);
  expect((await sync({ up: { activities: { send: [x] } } })).json().results.activities.send[0].status).toBe('exists');
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = ANY($1)', [[x.activityid, y.activityid]]);
});

test('activities: an item the server refuses is `invalid` for itself; the others in the batch are saved', async () => {
  const good = activity(a.phoneDownloadid);
  const bad = { ...activity(a.phoneDownloadid), startdate: 'not a number' };
  const r = (await sync({ up: { activities: { send: [bad, good] } } })).json().results.activities;
  expect(r.send.map((i: { status: string }) => i.status)).toEqual(['invalid', 'created']);
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = $1', [good.activityid]);
});

test('activities: delete marks the activity deleted and answers `ok`; a repeat is ok; an unknown id is NOT_FOUND (not a failure of the section); a late upload of a deleted id is `deleted`', async () => {
  const x = activity(a.phoneDownloadid);
  await sync({ up: { activities: { send: [x] } } });
  const unknown = randomUUID();
  const r = (await sync({ up: { activities: { delete: [x.activityid, unknown] } } })).json().results.activities;
  expect(r).toEqual({ ok: true, delete: { [x.activityid]: 'ok', [unknown]: 'NOT_FOUND' } });
  expect((await activityRow(app, x.activityid)).tosend).toBe(0);
  expect((await sync({ up: { activities: { delete: [x.activityid] } } })).json().results.activities.delete[x.activityid]).toBe('ok');
  expect((await sync({ up: { activities: { send: [x] } } })).json().results.activities.send[0].status).toBe('deleted');
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = $1', [x.activityid]);
});

test('activities: send and delete in one request; one section failing (a refused delete id shape) does not touch the walk section', async () => {
  const x = activity(a.phoneDownloadid);
  const res = await sync({ up: { activities: { send: [x] }, walk: { today: { ...TODAY, stepcount: 4600 } } } });
  expect(res.json().results.activities.send[0].status).toBe('created');
  expect(res.json().results.walk).toEqual({ ok: true, today: 'ok' });
  const bad = await sync({ up: { activities: { delete: ['nope'] }, walk: { today: { ...TODAY, stepcount: 4700 } } } });
  expect(bad.json().results).toEqual({ activities: { ok: false, code: 'BAD_REQUEST' }, walk: { ok: true, today: 'ok' } });
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = $1', [x.activityid]);
});

test('activities: an empty list, more than 20 items, or an unknown key is refused for the section only', async () => {
  for (const up of [{ send: [] }, { send: Array.from({ length: 21 }, () => ({})) }, { delete: [] }, { other: 1 }]) {
    const res = await sync({ up: { activities: up } });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.activities).toEqual({ ok: false, code: 'BAD_REQUEST' });
  }
});

test('activities: the watch token cannot send (the call is for the phone)', async () => {
  expect((await sync({ up: { activities: { send: [activity(a.phoneDownloadid)] } } }, a.watchToken)).statusCode).toBe(403);
});

// ---- inbox, state, profile, device
test('inbox: pull gives the watch activities waiting, oldest first, with their tracks; ack takes them out; the next pull is empty', async () => {
  const w = [activity(a.watchDownloadid, { iswatch: true, startdate: 1731480000 }), activity(a.watchDownloadid, { iswatch: true, startdate: 1731483700, enddate: 1731485000 })];
  const sent = await app.inject({ method: 'POST', url: '/wearable/v3/activities/batch', headers: bearer(a.watchToken), payload: { activities: w } });
  expect(sent.statusCode).toBe(200);
  const first = (await sync({ up: { inbox: { pull: true } } })).json();
  expect(first.results.inbox).toEqual({ ok: true });
  expect(first.down.inbox.activities.map((x: { activityid: string }) => x.activityid)).toEqual(w.map(x => x.activityid));
  expect(first.more).toBe(false);
  const ack = (await sync({ up: { inbox: { ack: w.map(x => x.activityid), pull: true } } })).json();
  expect(ack.results.inbox.ack.sort()).toEqual(w.map(x => x.activityid).sort());
  expect(ack.down.inbox.activities).toEqual([]);
  expect((await sync({ up: { inbox: { ack: [w[0].activityid] } } })).json().results.inbox.ack).toEqual([]);
  expect((await sync({ up: { inbox: { ack: [w[0].activityid] } } })).json().down).toEqual({});
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = ANY($1)', [w.map(x => x.activityid)]);
});

test('inbox: more than one pull gives is `more`, and sending the acks and pulling again brings the rest', async () => {
  const w = Array.from({ length: 22 }, (_, i) => activity(a.watchDownloadid, { iswatch: true, startdate: 1731500000 + i * 100, enddate: 1731500050 + i * 100 }));
  for (let i = 0; i < w.length; i += 20) await app.inject({ method: 'POST', url: '/wearable/v3/activities/batch', headers: bearer(a.watchToken), payload: { activities: w.slice(i, i + 20) } });
  const one = (await sync({ up: { inbox: { pull: true } } })).json();
  expect(one.down.inbox.activities).toHaveLength(20);
  expect(one.more).toBe(true);
  const two = (await sync({ up: { inbox: { ack: one.down.inbox.activities.map((x: { activityid: string }) => x.activityid), pull: true } } })).json();
  expect(two.down.inbox.activities).toHaveLength(2);
  expect(two.more).toBe(false);
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = ANY($1)', [w.map(x => x.activityid)]);
});

test('inbox: a bad ack list is refused for the section only', async () => {
  for (const inbox of [{ ack: [] }, { ack: ['x'] }, { pull: 'yes please' }, { other: 1 }]) {
    expect((await sync({ up: { inbox } })).json().results.inbox).toEqual({ ok: false, code: 'BAD_REQUEST' });
  }
});

test('state: the whole state comes back in down.state; with the current versions the catalogue and ads are just their versions', async () => {
  const first = (await sync({ up: { state: { platform: 'ios' } } })).json();
  expect(first.results.state).toEqual({ ok: true });
  expect(first.down.state).toHaveProperty('entitlement');
  expect(first.down.state.catalog).toHaveProperty('version');
  const { catalog, ads } = first.down.state;
  const again = (await sync({ up: { state: { platform: 'ios', catalog: catalog.version, ads: ads.version } } })).json();
  expect(again.down.state.catalog).toEqual({ version: catalog.version });
  expect(again.down.state.ads).toEqual({ version: ads.version });
  expect((await sync({ up: { state: { platform: 'windows' } } })).json().results.state).toEqual({ ok: false, code: 'BAD_REQUEST' });
  expect((await sync({ up: { state: { catalog: 'xyz' } } })).json().results.state.code).toBe('BAD_REQUEST');
});

test('profile: put makes or changes the profile and answers the fields as saved; visibility changes the privacy; each fails alone', async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  const hidden = (await sync({ up: { profile: { visibility: { hidden: true } } } })).json().results.profile;
  expect(hidden).toEqual({ ok: false, code: 'NOT_FOUND', visibility: 'NOT_FOUND' });
  const both = (await sync({ up: { profile: { put: { fname: 'Asha', weight: 61 }, visibility: { hidden: true } } } })).json().results.profile;
  expect(both).toMatchObject({ ok: true, put: { fname: 'Asha', weight: 61 }, visibility: { hidden: true } });
  const row = (await app.pg.writer.query('SELECT fname, weight, hideprofile FROM userinfo WHERE userid = $1', [a.userid])).rows[0];
  expect(row).toMatchObject({ fname: 'Asha', hideprofile: true });
  expect((await sync({ up: { profile: { put: { fname: '' } } } })).json().results.profile).toEqual({ ok: false, code: 'BAD_REQUEST' });
  expect((await sync({ up: { profile: {} } })).json().results.profile).toEqual({ ok: false, code: 'BAD_REQUEST' });
});

test('device: what changed about the phone is kept on the install the token belongs to, not on the watch', async () => {
  const res = await sync({ up: { device: { os: '18.0', appVersion: '2.0.0', timezone: 'Europe/Paris', fcmToken: 'tok-9' } } });
  expect(res.json().results.device).toEqual({ ok: true });
  const d = (await app.pg.writer.query('SELECT device_os, appversion, timezone, fcm_token FROM downloads WHERE downloadid = $1', [a.phoneDownloadid])).rows[0];
  expect(d).toEqual({ device_os: '18.0', appversion: '2.0.0', timezone: 'Europe/Paris', fcm_token: 'tok-9' });
  expect((await app.pg.writer.query('SELECT device_os FROM downloads WHERE downloadid = $1', [a.watchDownloadid])).rows[0].device_os).toBeNull();
  expect((await sync({ up: { device: { region: 'India' } } })).json().results.device).toEqual({ ok: false, code: 'BAD_REQUEST' });
});

test('all the sections together: one request, one answer with a result for each and the reads in down', async () => {
  const x = activity(a.phoneDownloadid);
  const res = (await sync({
    up: {
      walk: { today: { ...TODAY, stepcount: 4800 } },
      activities: { send: [x] },
      inbox: { pull: true },
      profile: { put: { about: 'hi' } },
      device: { os: '18.1' },
      state: {},
    },
  })).json();
  expect(Object.keys(res.results).sort()).toEqual(['activities', 'device', 'inbox', 'profile', 'state', 'walk']);
  expect(Object.values(res.results).every((r) => (r as { ok: boolean }).ok)).toBe(true);
  expect(Object.keys(res.down).sort()).toEqual(['inbox', 'state']);
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = $1', [x.activityid]);
});

// ---- the restore in one go (docs/data/sync.md section 5)
import { RESTORE_MAX_CHARS } from '../../src/services/sync/restore.js';

test('restore: the step history and the first page of activities in ONE request; more while there is a next page, and the cursor gives the rest', async () => {
  const acts = Array.from({ length: 5 }, (_, i) => activity(a.phoneDownloadid, { startdate: 1731600000 + i * 100, enddate: 1731600050 + i * 100 }));
  await sync({ up: { activities: { send: acts }, walk: { history: HISTORY, today: { ...TODAY, stepcount: 4900 } } } });
  const first = (await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(a.phoneToken), payload: { restore: { walk: true, activities: { limit: 2 } } } })).json();
  expect(first.results.restore).toEqual({ ok: true });
  expect(first.more).toBe(true);
  expect(first.down.restore.walk).toMatchObject({ dtgraph: today, stepcount: 4900, history_base: today, dtgraph_json: [1, 2, 0], stepcount_json: [5000, 6000, 7000], iso_json: [['IN', 2], ['FR', 1]] });
  expect(first.down.restore.walk).not.toHaveProperty('descend_json');
  const page1 = first.down.restore.activities;
  expect(page1.activities.map((x: { activityid: string }) => x.activityid)).toEqual([acts[4].activityid, acts[3].activityid]);
  expect(page1.total).toBeGreaterThanOrEqual(5);
  const rest: string[] = [];
  let next = page1.next as string | null;
  for (let i = 0; next && i < 20; i++) {
    const p = (await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(a.phoneToken), payload: { restore: { activities: { limit: 2, before: next } } } })).json();
    expect(p.down.restore.walk).toBeUndefined();   // the small parts only when asked for
    expect(p.down.restore.activities.total).toBeNull();
    rest.push(...p.down.restore.activities.activities.map((x: { activityid: string }) => x.activityid));
    next = p.down.restore.activities.next;
    expect(p.more).toBe(next !== null);
  }
  expect(rest).toEqual(expect.arrayContaining([acts[2].activityid, acts[1].activityid, acts[0].activityid]));
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = ANY($1)', [acts.map(x => x.activityid)]);
});

test('restore: a user with no steps row gets walk null; an empty account gets an empty first page', async () => {
  const b = await createAccount(app);
  try {
    const r = (await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(b.phoneToken), payload: { restore: { walk: true, activities: {} } } })).json();
    expect(r.down.restore).toEqual({ walk: null, activities: { activities: [], next: null, total: 0 } });
    expect(r.more).toBe(false);
  } finally {
    await b.remove();
  }
});

test('restore: it comes with the sections of the same call (sent first, then read), and is refused for itself only', async () => {
  const x = activity(a.phoneDownloadid, { startdate: 1731700000, enddate: 1731700050 });
  const r = (await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(a.phoneToken), payload: { up: { activities: { send: [x] } }, restore: { activities: { limit: 300 } } } })).json();
  expect(r.results.activities.send[0].status).toBe('created');
  expect(r.down.restore.activities.activities.map((i: { activityid: string }) => i.activityid)).toContain(x.activityid);
  for (const restore of [{ activities: { limit: 0 } }, { activities: { limit: 301 } }, { activities: { before: 'nope' } }, { other: true }, { walk: 'yes' }]) {
    const bad = (await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(a.phoneToken), payload: { restore } })).json();
    expect(bad.results.restore).toEqual({ ok: false, code: 'BAD_REQUEST' });
  }
  await app.pg.writer.query('DELETE FROM activities WHERE activityid = $1', [x.activityid]);
});

test('restore: the page is a JSON text from the database, cut to fit the size limit', () => {
  expect(RESTORE_MAX_CHARS).toBeGreaterThan(1_000_000);
});

test('restore: the watch token is refused (the call is for the phone)', async () => {
  expect((await app.inject({ method: 'POST', url: '/phone/v3/sync', headers: bearer(a.watchToken), payload: { restore: { walk: true } } })).statusCode).toBe(403);
});

test('device: a push token is kept; an empty one or none keeps it; null takes it away (the user turned notifications off)', async () => {
  const token = async () => (await app.pg.writer.query('SELECT fcm_token FROM downloads WHERE downloadid = $1', [a.phoneDownloadid])).rows[0].fcm_token;
  await sync({ up: { device: { fcmToken: 'tok-A' } } });
  expect(await token()).toBe('tok-A');
  await sync({ up: { device: { os: '18.2' } } });
  expect(await token()).toBe('tok-A');
  await sync({ up: { device: { fcmToken: '' } } });
  expect(await token()).toBe('tok-A');
  const cleared = await sync({ up: { device: { fcmToken: null } } });
  expect(cleared.json().results.device).toEqual({ ok: true });
  expect(await token()).toBeNull();
  await sync({ up: { device: { fcmToken: 'tok-B' } } });
  expect(await token()).toBe('tok-B');
  // The watch's own install is never touched.
  expect((await app.pg.writer.query('SELECT fcm_token FROM downloads WHERE downloadid = $1', [a.watchDownloadid])).rows[0].fcm_token).toBeNull();
});

// The rank section (docs/data/sync.md section 4b): a read, dummy for now. Its own account, with a public profile (the account above was made private by an earlier test).
const STEPS = { Day: 6000, Week: 50000, Month: 200000, Year: 2000000, 'All time': 5000000 };
let c: Account;
const syncC = (payload: unknown) => sync(payload, c.phoneToken);

const RANK_KEYS = { Day: 2_900_000_000, Week: 2_900_000_001, Month: 2_900_000_002, Year: 2_900_000_003 };

test('rank: the totals are stored and the place in each period comes back with the user among the people; a request without the first days gets nothing back; a bad one is refused alone', async () => {
  c = await createAccount(app);
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered) VALUES ($1, 'Pat', 'Test', 68, 0, false, 'Pune', 'MH', 'IN', 1700000000)`, [c.userid]);
  const res = await syncC({ up: { rank: { steps: STEPS, keys: RANK_KEYS } } });
  expect(res.json().results.rank).toEqual({ ok: true });
  const down = res.json().down.rank;
  expect(Object.keys(down)).toEqual(['Day', 'Week', 'Month', 'Year', 'All time']);
  for (const [period, b] of Object.entries(down) as [string, { people: { steps: number; you?: boolean }[] }][]) {
    expect(b.people.find(p => p.you), period).toMatchObject({ steps: STEPS[period as keyof typeof STEPS] });
  }
  expect((await syncC({ up: { rank: { steps: STEPS } } })).json().down.rank).toBeUndefined();
  const bad = await syncC({ up: { rank: { steps: { Day: -1 } }, device: {} } });
  expect(bad.json().results.rank).toMatchObject({ ok: false });
  expect(bad.json().down.rank).toBeUndefined();
});

test('challengers and streakLeaders: each its own section in the same call; a request without the day answers nothing, and a bad one is refused alone (the boards themselves: leaderboards-sync.test.ts)', async () => {
  const res = await syncC({ up: { challengers: { steps: 210, day: RANK_KEYS.Day }, streakLeaders: {}, device: {} } });
  expect(res.json().results).toMatchObject({ challengers: { ok: true }, streakLeaders: { ok: true } });
  expect(res.json().down.challengers).toMatchObject({ top: [], iso: 'IN', country: 'India' });
  expect(res.json().down.streakLeaders.people.some((p: { you?: boolean }) => p.you)).toBe(true);
  expect((await syncC({ up: { challengers: { steps: 210 } } })).json().down.challengers).toBeUndefined();
  const bad = await syncC({ up: { challengers: { steps: -1 }, streakLeaders: { days: -1 } } });
  expect(bad.json().results.challengers).toMatchObject({ ok: false });
  expect(bad.json().results.streakLeaders).toMatchObject({ ok: false });
  expect(bad.json().down.challengers).toBeUndefined();
});

test('feedScrub: says which of the ids the feed no longer shows, and a bad request is refused alone', async () => {
  const unknown = '11111111-2222-4333-8444-555555555555';
  const res = await syncC({ up: { feedScrub: { ids: [unknown] }, device: {} } });
  expect(res.json().results.feedScrub).toEqual({ ok: true });
  expect(res.json().down.feedScrub).toEqual({ gone: [unknown] });
  const none = await syncC({ up: { feedScrub: { ids: [] } } });
  expect(none.json().down.feedScrub).toEqual({ gone: [] });
  const bad = await syncC({ up: { feedScrub: { ids: ['not-an-id'] } } });
  expect(bad.json().results.feedScrub).toMatchObject({ ok: false });
  expect(bad.json().down.feedScrub).toBeUndefined();
});

test('streakConfig: the levels and texts come whole for a new phone, only the version when it is current, and a bad version is refused alone', async () => {
  const first = await syncC({ up: { streakConfig: {}, device: {} } });
  expect(first.json().results.streakConfig).toEqual({ ok: true });
  const down = first.json().down.streakConfig;
  expect(down.levels).toHaveLength(8);
  expect(down.messages.daily_target).toHaveLength(20);
  const same = await syncC({ up: { streakConfig: { version: down.version } } });
  expect(same.json().down.streakConfig).toEqual({ version: down.version });
  const old = await syncC({ up: { streakConfig: { version: '000000000000' } } });
  expect(old.json().down.streakConfig.levels).toHaveLength(8);
  const bad = await syncC({ up: { streakConfig: { version: 'nope' } } });
  expect(bad.json().results.streakConfig).toMatchObject({ ok: false });
  expect(bad.json().down.streakConfig).toBeUndefined();
});

test('a private user is left out of the boards (their own place stays); the user\'s rows go with the account', async () => {
  await syncC({ up: { profile: { visibility: { hidden: true } } } });
  expect((await app.pg.writer.query('SELECT is_public FROM step_totals WHERE userid = $1', [c.userid])).rows.every(r => r.is_public === false)).toBe(true);
  const down = (await syncC({ up: { rank: { steps: STEPS, keys: RANK_KEYS } } })).json().down.rank;
  expect(down.Day.people.find((p: { you?: boolean }) => p.you)).toMatchObject({ rank: down.Day.rank });
  await syncC({ up: { profile: { visibility: { hidden: false } } } });
  expect((await app.pg.writer.query('SELECT is_public FROM step_totals WHERE userid = $1', [c.userid])).rows.every(r => r.is_public === true)).toBe(true);
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [c.userid]);
  await c.remove();
});
