import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, WEARABLE_BATCH, activity, activityRow, bearer } from '../helpers/fixtures.js';

let app: TestApp;
let me: Account, other: Account;
beforeAll(async () => { app = await build(); me = await createAccount(app); other = await createAccount(app); });
afterAll(async () => { await me.remove(); await other.remove(); await app.close(); });

const del = (url: string, token: string) => app.inject({ method: 'DELETE', url, headers: bearer(token) });
const phoneDel = (id: string, token = me.phoneToken) => del(`/phone/v3/activities/${id}`, token);
const upload = (token: string, items: object[], url = PHONE_BATCH) => app.inject({ method: 'POST', url, headers: bearer(token), payload: { activities: items } });

test('delete leaves a marker: tosend 0, the large columns emptied, the small summary kept', async () => {
  const a = activity(me.phoneDownloadid, { media_v2: [{ type: 'photo', value: 'x.webp' }], activitybpm_v2: { t: [0], v: [100] } });
  await upload(me.phoneToken, [a]);
  const before = await activityRow(app, a.activityid);
  expect(before.activitylat).not.toBeNull();

  const res = await phoneDel(a.activityid);
  expect(res.statusCode).toBe(204);
  expect(res.body).toBe('');

  const r = await activityRow(app, a.activityid);
  expect(r.tosend).toBe(0);
  for (const c of ['activitydetail_v2', 'activitybpm_v2', 'activitylat', 'activitylon', 'activitytimenow', 'activityelevation', 'activitydistance', 'activitydetail', 'activitybpm', 'media']) {
    expect(r[c], c).toBeNull();
  }
  expect(r.media_v2).toEqual([]);
  expect(r.media_details).toEqual([]);
  expect(r).toMatchObject({ userid: me.userid, startdate: 1731480000, enddate: 1731483600, distance: 9210, stepcount: 8123, city: 'Bengaluru', description: 'morning run' });
});

test('a repeat delete is 204 too, and an unknown or foreign id is 404 (the app treats 404 as success)', async () => {
  const a = activity(me.phoneDownloadid);
  await upload(me.phoneToken, [a]);
  expect((await phoneDel(a.activityid)).statusCode).toBe(204);
  expect((await phoneDel(a.activityid)).statusCode).toBe(204);

  const unknown = await phoneDel(randomUUID());
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json().code).toBe('NOT_FOUND');
  expect(unknown.json().errorId).toBe('');                     // routine: not logged

  const b = activity(me.phoneDownloadid);
  await upload(me.phoneToken, [b]);
  const foreign = await phoneDel(b.activityid, other.phoneToken);
  expect(foreign.statusCode).toBe(404);                        // does not reveal that it exists
  const r = await activityRow(app, b.activityid);
  expect(r.tosend).toBe(1);
  expect(r.activitylat).toEqual([0, 12, 15]);
});

test('a late upload of a deleted id is answered deleted and stays a marker', async () => {
  const a = activity(me.watchDownloadid, { iswatch: true });
  await upload(me.watchToken, [a], WEARABLE_BATCH);
  await phoneDel(a.activityid);
  const late = await upload(me.watchToken, [a], WEARABLE_BATCH);
  expect(late.json().results[0]).toEqual({ activityid: a.activityid, status: 'deleted', tosend: 0 });
  expect((await activityRow(app, a.activityid)).activitylat).toBeNull();
});

test('a deleted watch activity leaves the inbox', async () => {
  const a = activity(me.watchDownloadid, { iswatch: true });
  await upload(me.watchToken, [a], WEARABLE_BATCH);
  const ids = async () => (await app.inject({ url: '/phone/v3/activities/inbox', headers: bearer(me.phoneToken) })).json().activities.map((x: { activityid: string }) => x.activityid);
  expect(await ids()).toContain(a.activityid);
  await phoneDel(a.activityid);
  expect(await ids()).not.toContain(a.activityid);
});

test('the watch deletes with its own token, on its own path', async () => {
  const a = activity(me.phoneDownloadid);
  await upload(me.phoneToken, [a]);
  expect((await del(`/wearable/v3/activities/${a.activityid}`, me.watchToken)).statusCode).toBe(204);
  expect((await activityRow(app, a.activityid)).tosend).toBe(0);
});

test('bad id is a 400, a missing token is refused, and the other kind of token is 403', async () => {
  const bad = await phoneDel('not-a-uuid');
  expect(bad.statusCode).toBe(400);
  expect(bad.json().code).toBe('BAD_REQUEST');
  expect((await app.inject({ method: 'DELETE', url: `/phone/v3/activities/${randomUUID()}` })).json().code).toBe('INVALID_TOKEN_FORMAT');
  expect((await phoneDel(randomUUID(), me.watchToken)).json().code).toBe('WRONG_DEVICE');
  expect((await del(`/wearable/v3/activities/${randomUUID()}`, me.phoneToken)).json().code).toBe('WRONG_DEVICE');
});
