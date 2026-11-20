import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, WEARABLE_BATCH, activity, bearer } from '../helpers/fixtures.js';
import { phoneBatch, phoneDelete, phoneRestore } from '../helpers/viaSync.js';

let app: TestApp;
let me: Account, other: Account;
const base = 1731000000;
const ids: string[] = []; // newest first
const media = [{ type: 'photo', value: 'p.webp', dimension: [10, 20] }];

beforeAll(async () => {
  app = await build(); me = await createAccount(app); other = await createAccount(app);
  // 7 phone activities, one hour apart; the 3rd newest has a media list
  const items = Array.from({ length: 7 }, (_, i) => activity(me.phoneDownloadid, { startdate: base + i * 3600, enddate: base + i * 3600 + 1800, media_v2: i === 4 ? media : [] }));
  await phoneBatch(app, me.phoneToken, items);
  ids.push(...items.map((a) => a.activityid).reverse());
});
afterAll(async () => { await me.remove(); await other.remove(); await app.close(); });

// The phone's restore is a part of the sync call now; the watch's list is still its own route.
const get = (url: string, token = me.phoneToken) => {
  const m = /^\/phone\/v3\/activities(?:\?(.*))?$/.exec(url);
  if (!m) return app.inject({ url, headers: bearer(token) });
  const q = new URLSearchParams(m[1] ?? '');
  return phoneRestore(app, token, { ...(q.get('limit') ? { limit: Number(q.get('limit')) } : {}), ...(q.get('before') ? { before: q.get('before') as string } : {}) });
};
const idsOf = (res: { json(): { activities: { activityid: string }[] } }) => res.json().activities.map((a) => a.activityid);

/** Every row of the phone's restore, newest first. */
async function allRows() {
  const rows: Record<string, unknown>[] = [];
  let before = '';
  for (let i = 0; i < 50; i++) {
    const body = (await get(`/phone/v3/activities?limit=50${before}`)).json();
    rows.push(...body.activities);
    if (!body.next) break;
    before = `&before=${body.next}`;
  }
  return rows as (Record<string, unknown> & { activityid: string; lat: number; lon: number })[];
}

async function walk(path: string, limit: number, token = me.phoneToken) {
  const seen: string[] = []; const pages: { activities: { activityid: string }[]; next: string | null; total: number | null }[] = [];
  let before = '';
  for (let i = 0; i < 50; i++) {
    const res = await get(`${path}?limit=${limit}${before}`, token);
    expect(res.statusCode).toBe(200);
    const body = res.json(); pages.push(body); seen.push(...body.activities.map((a: { activityid: string }) => a.activityid));
    if (!body.next) break;
    before = `&before=${body.next}`;
  }
  return { seen, pages };
}

test('full pages: newest first, every activity once, total on the first page only, deleted markers never', async () => {
  const gone = activity(me.phoneDownloadid, { startdate: base + 99 * 3600, enddate: base + 99 * 3600 + 60 });
  await phoneBatch(app, me.phoneToken, [gone]);
  await phoneDelete(app, me.phoneToken, gone.activityid);

  const { seen, pages } = await walk('/phone/v3/activities', 3);
  expect(seen).toEqual(ids);                                  // newest first, none missing, none twice, no marker
  expect(pages.map((p) => p.activities.length)).toEqual([3, 3, 1]);
  expect(pages[0].total).toBe(7);                             // the marker is not counted
  expect(pages[1].total).toBeNull(); expect(pages[2].total).toBeNull();
  expect(pages[2].next).toBeNull();
  const first = pages[0].activities[0] as Record<string, unknown>;
  expect(first.activitylat).toEqual([0, 12, 15]);             // full: the track is there
  expect(first.lat).toBe(12.971599);                          // the exact start point
  expect(first).not.toHaveProperty('userid');
});

test('paging survives equal start times and a newer activity arriving between pages', async () => {
  const acc = await createAccount(app);
  try {
    const same = Array.from({ length: 5 }, () => activity(acc.phoneDownloadid, { startdate: base, enddate: base + 10 }));
    await phoneBatch(app, acc.phoneToken, same);
    const p1 = (await get('/phone/v3/activities?limit=2', acc.phoneToken)).json();
    const newer = activity(acc.phoneDownloadid, { startdate: base + 5000, enddate: base + 5100 });
    await phoneBatch(app, acc.phoneToken, [newer]);
    const rest: string[] = [];
    let next: string | null = p1.next;
    while (next) { const p = (await get(`/phone/v3/activities?limit=2&before=${next}`, acc.phoneToken)).json(); rest.push(...p.activities.map((a: { activityid: string }) => a.activityid)); next = p.next; }
    const all = [...p1.activities.map((a: { activityid: string }) => a.activityid), ...rest];
    expect(all.sort()).toEqual(same.map((a) => a.activityid).sort());    // all 5, once each, and not the newer one (it is above the cursor)
  } finally { await acc.remove(); }
});

test('an old-format row is sent with its old columns, as they are in the database', async () => {
  const id = randomUUID();
  await app.pg.writer.query(
    `INSERT INTO activities (activityid, userid, startdate, enddate, dtgraph, lat, lon, geom, duration, distance, tosend, activitylat, activitylon, activitytimenow, activitydetail, activitybpm, media, media_details)
     VALUES ($1, $2, 1000000000, 1000003600, 11574*86400, 12.9, 77.5, ST_MakePoint(77.5, 12.9), 3600, 5000, 1, '[0,1]', '[0,2]', '[0,1]', '[3,3]', '[90,95]', '["a.webp","b.webp"]', '[{"w":1}]')`, [id, me.userid]);
  const row = (await allRows()).find((a) => a.activityid === id)!;
  expect(row).toMatchObject({ activityid: id, dtgraph: 11574 * 86400, activitydetail: [3, 3], activitybpm: [90, 95], media: ['a.webp', 'b.webp'], media_details: [{ w: 1 }], activitydetail_v2: null, activitylat: [0, 1] });
});
test('start point: a NEW row gets the exact doubles from geom, an OLD row gets the lat/lon columns, never a wrong geom', async () => {
  const insertOld = (id: string, gx: number, gy: number) => app.pg.writer.query(
    `INSERT INTO activities (activityid, userid, startdate, enddate, dtgraph, lat, lon, geom, duration, distance, tosend, activitylat, activitylon, activitytimenow)
     VALUES ($1, $2, 1000000100, 1000003700, 11574*86400, 19.11927, 72.89425, ST_MakePoint($3, $4), 600, 900, 1, '[0,1]', '[0,2]', '[0,1]')`, [id, me.userid, gx, gy]);
  const swapped = randomUUID(), zero = randomUUID(), good = randomUUID();
  await insertOld(swapped, 19.11927, 72.89425);   // geom is (lat, lon): production has such rows
  await insertOld(zero, 0, 0);                    // geom is (0, 0): production has such rows too
  await insertOld(good, 72.89425, 19.11927);      // geom is right (lon, lat)
  const rows = await allRows();
  for (const id of [swapped, zero, good]) {
    const a = rows.find((x) => x.activityid === id)!;
    expect([a.lat, a.lon], id).toEqual([19.11927, 72.89425]);   // the columns, whatever geom says
  }
  // a new-format row (activitydetail_v2 present) still gets the exact start point from geom, 6 decimals that a REAL column could not hold
  const fresh = rows.find((x) => x.activityid === ids[0])!;
  expect([fresh.lat, fresh.lon]).toEqual([12.971599, 77.594566]);
});
test('the watch gets only its own activities, whatever it asks for, and never more than 50', async () => {
  const w = [activity(me.watchDownloadid, { iswatch: true, startdate: base + 10, enddate: base + 20 }), activity(me.watchDownloadid, { iswatch: true, startdate: base + 30, enddate: base + 40 })];
  await app.inject({ method: 'POST', url: WEARABLE_BATCH, headers: bearer(me.watchToken), payload: { activities: w } });
  const watchIds = [w[1].activityid, w[0].activityid];
  // this user also has phone activities: none of them may reach the watch, with or without an `iswatch` in the query
  for (const q of ['', '?iswatch=false', '?iswatch=true', '?limit=50&before=' + '1000000000.' + randomUUID()]) {
    const res = await get('/wearable/v3/activities' + q, me.watchToken);
    expect(res.statusCode, q).toBe(200);
    expect(idsOf(res), q).toEqual(watchIds);
    expect(res.json().total, q).toBe(2);                          // counts the watch's own only
  }
  const res = await get('/wearable/v3/activities?limit=1', me.watchToken);
  expect(idsOf(res)).toEqual([watchIds[0]]);                      // the most recent one
  expect(res.json().activities[0].activitylat).toEqual([0, 12, 15]);
  expect(res.json().next).toBeTruthy();
  expect((await get('/wearable/v3/activities?limit=51', me.watchToken)).statusCode).toBe(400);
  expect((await get('/wearable/v3/activities/summaries', me.watchToken)).json().code).toBe('NOT_FOUND');
});
test('the request is checked: limit (1 to 300) and cursor (phone), limit (watch)', async () => {
  for (const q of ['?limit=0', '?limit=301', '?limit=x', '?before=nope', '?before=99999999999.' + randomUUID()]) {
    const res = await get('/phone/v3/activities' + q);
    expect(res.statusCode, q).toBe(400);
    expect(res.json().code, q).toBe('BAD_REQUEST');
  }
  expect((await get('/phone/v3/activities/summaries')).json().code).toBe('NOT_FOUND');          // no summaries: everything is restored in full
  expect((await get('/phone/v3/activities/' + randomUUID())).json().code).toBe('NOT_FOUND');    // and no single-activity read
  for (const q of ['?limit=0', '?limit=x']) expect((await get('/wearable/v3/activities' + q, me.watchToken)).statusCode, q).toBe(400);
});
test('only the user\'s own, and the right kind of token', async () => {
  expect((await get('/phone/v3/activities', other.phoneToken)).json()).toMatchObject({ activities: [], next: null, total: 0 });
  expect((await get('/phone/v3/activities', me.watchToken)).json().code).toBe('WRONG_DEVICE');
  expect((await get('/wearable/v3/activities', me.phoneToken)).json().code).toBe('WRONG_DEVICE');
  expect((await phoneRestore(app, null)).json().code).toBe('INVALID_TOKEN_FORMAT');
});

test('replies are gzip when the app asks, and decode to the same JSON', async () => {
  const call = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/phone/v3/sync', headers: { ...bearer(me.phoneToken), ...headers }, payload: { restore: { activities: { limit: 7 } } } });
  const gz = await call({ 'accept-encoding': 'gzip' });
  expect(gz.headers['content-encoding']).toBe('gzip');
  const plain = await call({});
  expect(plain.headers['content-encoding']).toBeUndefined();
  expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toEqual(plain.json());
});
