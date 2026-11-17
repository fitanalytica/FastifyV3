import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { PHONE_BATCH, activity, activityRow, bearer } from '../../helpers/fixtures.js';

let app: TestApp;
let me: Account, other: Account;

beforeAll(async () => { app = await build(); me = await createAccount(app); other = await createAccount(app); });
afterAll(async () => { await me.remove(); await other.remove(); await app.close(); });

const act = (over: Record<string, unknown> = {}) => activity(me.phoneDownloadid, over);
const post = (token: string | null, activities: unknown) =>
  app.inject({ method: 'POST', url: PHONE_BATCH, headers: token ? bearer(token) : {}, payload: { activities } });
const send = (activities: unknown) => post(me.phoneToken, activities);

test('creates a row: owner from the token, tosend from the device, geom from lat/lon, nulls stay NULL', async () => {
  const a = act();
  const res = await send([a]);
  expect(res.statusCode).toBe(200);
  expect(res.json().results).toEqual([{ activityid: a.activityid, status: 'created', tosend: 1 }]);
  const r = await activityRow(app, a.activityid);
  expect(r.userid).toBe(me.userid);                 // not the userid in the body
  expect(r.tosend).toBe(1);
  expect(r.iswatch).toBe(false);
  expect(r.gx).toBeCloseTo(77.594566, 9); expect(r.gy).toBeCloseTo(12.971599, 9); // exact doubles, longitude first
  expect(r.activitylat).toEqual([0, 12, 15]);
  expect(r.activitydetail_v2).toEqual({ enc: 1, tz: 19800, breaks: [] });
  expect(r.activitybpm_v2).toBeNull();
  expect(r.media_v2).toEqual([]);
  expect(r.city).toBe('Bengaluru');
});

test('a repeat changes only the editable columns', async () => {
  const a = act();
  await send([a]);
  const media = [{ type: 'photo', value: 'x.webp', dimension: [10, 20] }];
  // a resend may leave the track out (phone.md section 5): the stored track must stay
  const { activitylat, activitylon, activitytimenow, activityelevation, activitydistance, ...noTrack } = a;
  const again = await send([{ ...noTrack, description: 'edited', media_v2: media, distance: 1, stepcount: 1, iswatch: true, downloadid: me.watchDownloadid }]);
  expect(again.json().results[0]).toEqual({ activityid: a.activityid, status: 'exists', tosend: 1 });
  const r = await activityRow(app, a.activityid);
  expect(r.description).toBe('edited');
  expect(r.media_v2).toEqual(media);
  expect(r.distance).toBe(9210); expect(r.stepcount).toBe(8123);   // unchanged
  expect(r.iswatch).toBe(false); expect(r.downloadid).toBe(me.phoneDownloadid);
  expect(r.activitylat).toEqual([0, 12, 15]);
});

test("another user's activityid is not_owner and the row is untouched", async () => {
  const a = act();
  await send([a]);
  const res = await post(other.phoneToken, [{ ...a, description: 'stolen', downloadid: other.phoneDownloadid }]);
  expect(res.json().results[0]).toEqual({ activityid: a.activityid, status: 'invalid', error: 'not_owner' });
  expect((await activityRow(app, a.activityid)).description).toBe('morning run');
});

test('a deleted marker answers deleted and is not edited', async () => {
  const a = act();
  await send([a]);
  await app.pg.writer.query('UPDATE activities SET tosend = 0 WHERE activityid = $1', [a.activityid]);
  const res = await send([{ ...a, description: 'revive', media_v2: [{ type: 'photo', value: 'y.webp' }] }]);
  expect(res.json().results[0]).toEqual({ activityid: a.activityid, status: 'deleted', tosend: 0 });
  const r = await activityRow(app, a.activityid);
  expect(r.tosend).toBe(0); expect(r.description).toBe('morning run'); expect(r.media_v2).toEqual([]);
});

test('invalid items are answered one by one, in order, and the good ones are still written', async () => {
  const good = act(), good2 = act();
  const items = [
    good,
    act({ enddate: 5 }),                                 // ends before it starts
    act({ lat: 95 }),
    act({ downloadid: other.phoneDownloadid }),          // a download of another user
    act({ activitylon: [0, 1] }),                        // arrays of different length
    act({ description: 'x'.repeat(201) }),
    act({ temp: 40000 }),
    { nope: true },
    good2,
  ];
  const res = (await send(items)).json().results;
  expect(res.map((r: { error?: string; status: string }) => r.error ?? r.status)).toEqual(
    ['created', 'bad_dates', 'bad_location', 'bad_downloadid', 'bad_track', 'description_too_long', 'bad_temp', 'bad_activityid', 'created']);
  expect((await activityRow(app, good.activityid)).tosend).toBe(1);
  expect(await activityRow(app, good2.activityid)).toBeTruthy();
});

test('the same id twice in one batch: one row, the later item wins, both answered', async () => {
  const a = act();
  const res = (await send([a, { ...a, description: 'second' }])).json().results;
  expect(res.map((r: { status: string }) => r.status)).toEqual(['created', 'created']);
  expect((await activityRow(app, a.activityid)).description).toBe('second');
});

test('a data error in one item falls back to one write per item', async () => {
  const a = act(), b = act();
  const real = app.pg.writer.query.bind(app.pg.writer) as (...args: unknown[]) => unknown;
  let first = true;
  const spy = vi.spyOn(app.pg.writer, 'query').mockImplementation(((...args: unknown[]) => {
    if (first && typeof args[0] === 'string' && args[0].includes('INSERT INTO activities')) {
      first = false;
      return Promise.reject(Object.assign(new Error('x'), { code: '22003' }));
    }
    return real(...args);
  }) as never);
  const res = (await send([a, b])).json().results;
  spy.mockRestore();
  expect(res.map((r: { status: string }) => r.status)).toEqual(['created', 'created']);
});

test('limits and auth', async () => {
  expect((await send([])).json().code).toBe('BAD_BATCH');
  expect((await send('x')).statusCode).toBe(400);
  expect((await send(Array.from({ length: 21 }, () => act()))).json().code).toBe('BAD_BATCH');
  expect((await send(Array.from({ length: 20 }, () => act()))).statusCode).toBe(200);
  expect((await post(null, [act()])).json().code).toBe('INVALID_TOKEN_FORMAT');
  expect((await post('a.b.c', [act()])).json().code).toBe('LOGOUT');
});

test('a gzip-compressed body is accepted', async () => {
  const a = act();
  const res = await app.inject({ method: 'POST', url: PHONE_BATCH,
    headers: { ...bearer(me.phoneToken), 'content-type': 'application/json', 'content-encoding': 'gzip' },
    payload: gzipSync(JSON.stringify({ activities: [a] })) });
  expect(res.statusCode).toBe(200);
  expect(res.json().results[0].status).toBe('created');
});
