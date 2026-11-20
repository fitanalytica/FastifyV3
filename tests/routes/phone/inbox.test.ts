import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { PHONE_BATCH, WEARABLE_BATCH, activity, activityRow, bearer } from '../../helpers/fixtures.js';
import { phoneAck, phoneBatch, phoneDelete, phoneInbox } from '../../helpers/viaSync.js';

let app: TestApp;
let me: Account, other: Account;
beforeAll(async () => { app = await build(); me = await createAccount(app); other = await createAccount(app); });
afterAll(async () => { await me.remove(); await other.remove(); await app.close(); });

const inbox = (token: string | null) => phoneInbox(app, token);
const ack = (token: string | null, body: { ids?: unknown }) => phoneAck(app, token, body.ids);
const watchUpload = (acc: Account, items: object[]) => app.inject({ method: 'POST', url: WEARABLE_BATCH, headers: bearer(acc.watchToken), payload: { activities: items } });
const watchAct = (acc: Account, over: Record<string, unknown> = {}) => activity(acc.watchDownloadid, { iswatch: true, ...over });

test('the inbox holds what the watch uploaded, oldest first, in the form it was stored', async () => {
  const a = watchAct(me, { startdate: 1731480300, enddate: 1731480400 });
  const b = watchAct(me, { startdate: 1731480100, enddate: 1731480200 });
  const c = watchAct(me, { startdate: 1731480200, enddate: 1731480250, lat: -33.868819, lon: 151.209296 });
  await watchUpload(me, [a, b, c]);

  const res = await inbox(me.phoneToken);
  expect(res.statusCode).toBe(200);
  const { activities } = res.json();
  expect(activities.map((x: { activityid: string }) => x.activityid)).toEqual([b.activityid, c.activityid, a.activityid]);

  const first = activities[0];
  expect(first).toMatchObject({ downloadid: me.watchDownloadid, iswatch: true, description: 'morning run', city: 'Bengaluru', stepcount: 8123, distance: 9210 });
  expect(first.lat).toBe(12.971599); expect(first.lon).toBe(77.594566);                 // the exact start point, from geom (not REAL)
  expect(activities[1].lat).toBe(-33.868819); expect(activities[1].lon).toBe(151.209296);
  expect(first.activitylat).toEqual([0, 12, 15]);                                         // the compact arrays, as stored
  expect(first.activitytimenow).toEqual([1731480000, 1, 2]);
  expect(first.activitydetail_v2).toEqual({ enc: 1, tz: 19800, breaks: [] });
  expect(first.media_v2).toEqual([]);
  expect(first).not.toHaveProperty('userid');
  expect(first).not.toHaveProperty('tosend');
});

test('only waiting watch activities: not the phone\'s own, not deleted ones, not another user\'s', async () => {
  const mine = activity(me.phoneDownloadid);
  await phoneBatch(app, me.phoneToken, [mine]);
  const gone = watchAct(me);
  await watchUpload(me, [gone]);
  await phoneDelete(app, me.phoneToken, gone.activityid);
  const theirs = watchAct(other);
  await watchUpload(other, [theirs]);

  const ids = (await inbox(me.phoneToken)).json().activities.map((x: { activityid: string }) => x.activityid);
  expect(ids).not.toContain(mine.activityid);
  expect(ids).not.toContain(gone.activityid);
  expect(ids).not.toContain(theirs.activityid);
  expect((await inbox(other.phoneToken)).json().activities.map((x: { activityid: string }) => x.activityid)).toEqual([theirs.activityid]);
});

test('a pull gives the oldest first, up to 20; the rest is `more`', async () => {
  const acc = await createAccount(app); // a fresh user, so nothing else is waiting in the inbox
  try {
    const many = Array.from({ length: 5 }, (_, i) => watchAct(acc, { startdate: 1731490000 + i, enddate: 1731490100 + i }));
    await watchUpload(acc, [many[3], many[0], many[4], many[1], many[2]]); // sent out of order
    const all = (await inbox(acc.phoneToken)).json().activities;
    expect(all.map((x: { activityid: string }) => x.activityid)).toEqual(many.map(m => m.activityid)); // oldest first
  } finally {
    await acc.remove();
  }
});


test('ack moves items out of the inbox: only the user\'s own, only while waiting, and a repeat acks nothing', async () => {
  const x = watchAct(me), y = watchAct(me);
  await watchUpload(me, [x, y]);
  const foreign = watchAct(other);
  await watchUpload(other, [foreign]);
  const phoneOwn = activity(me.phoneDownloadid);
  await phoneBatch(app, me.phoneToken, [phoneOwn]);

  const res = await ack(me.phoneToken, { ids: [x.activityid, foreign.activityid, phoneOwn.activityid, randomUUID()] });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ acked: [x.activityid] });                                   // not another user's, not tosend 1, not unknown
  expect((await activityRow(app, x.activityid)).tosend).toBe(1);
  expect((await activityRow(app, foreign.activityid)).tosend).toBe(2);

  expect((await ack(me.phoneToken, { ids: [x.activityid] })).json()).toEqual({ acked: [] }); // a repeat is harmless
  const left = (await inbox(me.phoneToken)).json().activities.map((a: { activityid: string }) => a.activityid);
  expect(left).toContain(y.activityid);
  expect(left).not.toContain(x.activityid);

  await ack(me.phoneToken, { ids: left });
  expect((await inbox(me.phoneToken)).json()).toEqual({ activities: [] });
});

test('ack body is checked: 1 to 100 uuids', async () => {
  for (const body of [{ ids: [] }, { ids: ['nope'] }, { ids: 'x' }, { ids: Array.from({ length: 101 }, () => randomUUID()) }]) {
    const res = await ack(me.phoneToken, body);
    expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  }
  expect((await ack(me.phoneToken, { ids: Array.from({ length: 100 }, () => randomUUID()) })).statusCode).toBe(200);
});

test('the inbox is the phone\'s: a watch token is refused, and the watch has no inbox route', async () => {
  expect((await inbox(me.watchToken)).json().code).toBe('WRONG_DEVICE');
  expect((await ack(me.watchToken, { ids: [randomUUID()] })).json().code).toBe('WRONG_DEVICE');
  const w = await app.inject({ url: '/wearable/v3/activities/inbox', headers: bearer(me.watchToken) });
  expect(w.json().code).toBe('NOT_FOUND');                                                  // the inbox is the phone's
  expect((await inbox(null)).json().code).toBe('INVALID_TOKEN_FORMAT');
});
