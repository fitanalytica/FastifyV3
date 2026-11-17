import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';

// Public or private (docs/data/api.md section 7c): a private user is out of the feed and out of other people's reach, and back when public again.
let app: TestApp;
let a: Account, b: Account, noProfile: Account;
const T = 1990000000;

const put = (hidden: unknown, token = a.phoneToken) => app.inject({ method: 'PUT', url: '/phone/v3/profile/visibility', headers: bearer(token), payload: { hidden } as object });
const inFeed = async () => ((await app.inject({ url: '/phone/v3/feed', headers: bearer(b.phoneToken) })).json().posts as { author: { userid: string } }[]).some((p) => p.author.userid === a.userid);
const stored = async () => (await app.pg.writer.query('SELECT hideprofile FROM userinfo WHERE userid = $1', [a.userid])).rows[0].hideprofile;

beforeAll(async () => {
  app = await build();
  [a, b, noProfile] = [await createAccount(app), await createAccount(app), await createAccount(app)];
  for (const x of [a, b]) {
    await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered) VALUES ($1, 'Pat', 'Test', 68, 0, false, 'Pune', 'MH', 'IN', 1700000000)`, [x.userid]);
  }
  await app.inject({ method: 'POST', url: PHONE_BATCH, headers: bearer(a.phoneToken), payload: { activities: [activity(a.phoneDownloadid, { startdate: T, enddate: T + 60 })] } });
});
afterAll(async () => {
  for (const x of [a, b, noProfile]) await x.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[a.userid, b.userid]]);
  await app.close();
});

test('private takes the user out of the feed and other people\'s view; public brings them back', async () => {
  expect(await inFeed()).toBe(true);
  const res = await put(true);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ hidden: true });
  expect(await stored()).toBe(true);
  expect(await inFeed()).toBe(false);
  expect((await app.inject({ url: `/phone/v3/users/${a.userid}`, headers: bearer(b.phoneToken) })).statusCode).toBe(404);
  expect((await app.inject({ url: `/phone/v3/users/${a.userid}`, headers: bearer(a.phoneToken) })).statusCode).toBe(200);
  expect((await put(false)).json()).toEqual({ hidden: false });
  expect(await inFeed()).toBe(true);
});

test('a repeat changes nothing', async () => {
  await put(true);
  expect((await put(true)).statusCode).toBe(200);
  expect(await stored()).toBe(true);
});

test('no profile row yet is a 404 (the phone sends it again after the profile); a bad body is refused', async () => {
  const res = await put(true, noProfile.phoneToken);
  expect(res.statusCode).toBe(404);
  expect(res.json().code).toBe('NOT_FOUND');
  expect((await put('yes')).statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url: '/phone/v3/profile/visibility', headers: bearer(a.phoneToken), payload: {} })).statusCode).toBe(400);
});
