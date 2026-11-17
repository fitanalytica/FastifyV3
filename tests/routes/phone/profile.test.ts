import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { bearer } from '../../helpers/fixtures.js';

let app: TestApp;
let me: Account, nobody: Account;
beforeAll(async () => {
  app = await build(); me = await createAccount(app); nobody = await createAccount(app);
  await app.pg.writer.query(`UPDATE userlogin SET email = 'dummy@example.com', loginused = 'apple' WHERE userid = $1`, [me.userid]);
  await app.pg.writer.query(
    `INSERT INTO userinfo (userid, dateregistered, dobglobal, height, weight, seconds_from_gmt, hideprofile, gender, iso, fname, lname, city, state, lat, lon, geom, about, timezone, store_id, mailids)
     VALUES ($1, 1665014400, 252460800, 172.7, 70.5, 3600, false, 'male', 'DK', 'Dum', 'My', 'Copenhagen', 'Capital', 55.62913, 12.48244, ST_MakePoint(12.48244, 55.62913), 'About me', 'Europe/Copenhagen', gen_random_uuid(), 'secret')`, [me.userid]);
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [me.userid]);
  await me.remove(); await nobody.remove(); await app.close();
});

const get = (url: string, token: string) => app.inject({ url, headers: bearer(token) });

test('the profile and the account, from userinfo and userlogin; nothing internal', async () => {
  const res = await get('/phone/v3/profile', me.phoneToken);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('application/json');
  const { profile, account } = res.json();
  expect(profile).toEqual({
    fname: 'Dum', lname: 'My', about: 'About me', gender: 'male', dobglobal: 252460800, height: 172.7, weight: 70.5, hideprofile: false,
    timezone: 'Europe/Copenhagen', iso: 'DK', country: 'Denmark', city: 'Copenhagen', state: 'Capital', lat: 55.62913, lon: 12.48244, profilepic: null, profilebg: null,
    dateregistered: 1665014400, last_access_date: expect.any(Number), geo_source: null,
  });
  expect(account).toEqual({ email: 'dummy@example.com', loginused: 'apple' });
  for (const hidden of ['geom', 'store_id', 'mailids', 'userid', 'deleted_date']) expect(profile).not.toHaveProperty(hidden);
});

test('no profile yet is a 404 (the app reads it as a new user), and it is routine so it is not logged', async () => {
  const res = await get('/phone/v3/profile', nobody.phoneToken);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ code: 'NOT_FOUND', errorId: '' });
});

test('only the signed-in user\'s own profile, and the right kind of token', async () => {
  expect((await get('/phone/v3/profile', nobody.phoneToken)).statusCode).toBe(404);          // not me's
  expect((await get('/phone/v3/profile', me.watchToken)).json().code).toBe('WRONG_DEVICE');
  expect((await app.inject({ url: '/phone/v3/profile' })).json().code).toBe('INVALID_TOKEN_FORMAT');
  expect((await get('/wearable/v3/profile', me.watchToken)).json().code).toBe('NOT_FOUND');   // the watch has no profile
});
