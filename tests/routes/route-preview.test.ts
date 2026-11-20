import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';
import { phoneBatch } from '../helpers/viaSync.js';

let app: TestApp;
let me: Account;
beforeAll(async () => { app = await build(); me = await createAccount(app); });
afterAll(async () => { await me.remove(); await app.close(); });

const send = async (items: object[]) => (await phoneBatch(app, me.phoneToken, items)).json().results;
const stored = async (id: string) => (await app.pg.writer.query('SELECT route_preview FROM activities WHERE activityid = $1', [id])).rows[0].route_preview;
const PREVIEW = { p: [1297160, 7759457, 12, -4, 3, 1] };

test('a phone sends the route preview with the activity and the server stores it as it is', async () => {
  const a = activity(me.phoneDownloadid, { route_preview: PREVIEW });
  expect((await send([a]))[0].status).toBe('created');
  expect(await stored(a.activityid)).toEqual(PREVIEW);
});

test('an activity sent without one has none (NULL), and a JSON null is NULL too', async () => {
  const [a, b] = [activity(me.phoneDownloadid), activity(me.phoneDownloadid, { route_preview: null })];
  await send([a, b]);
  expect(await stored(a.activityid)).toBeNull();
  expect(await stored(b.activityid)).toBeNull();
});

test('a bad preview refuses that item only, with its reason', async () => {
  const [good, bad] = [activity(me.phoneDownloadid, { route_preview: PREVIEW }), activity(me.phoneDownloadid, { route_preview: { p: [1, 2, 3] } })];
  const r = await send([good, bad]);
  expect(r[0].status).toBe('created');
  expect(r[1]).toMatchObject({ status: 'invalid', error: 'bad_route_preview' });
});

test('a resend only ever fills the preview in: it never replaces one (the track a preview is made from does not change)', async () => {
  const none = activity(me.phoneDownloadid);
  const had = activity(me.phoneDownloadid, { route_preview: PREVIEW });
  await send([none, had]);
  await send([{ ...none, route_preview: PREVIEW }, { ...had, route_preview: { p: [9, 9, 9, 9] } }]);
  expect(await stored(none.activityid)).toEqual(PREVIEW);   // filled in
  expect(await stored(had.activityid)).toEqual(PREVIEW);    // kept
});
