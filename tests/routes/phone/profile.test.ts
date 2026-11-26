import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { bearer } from '../../helpers/fixtures.js';
import { phoneProfilePut } from '../../helpers/viaSync.js';
import { generateMailids } from '../../../src/services/profile/mailids.js';

let app: TestApp;
let me: Account, nobody: Account;
beforeAll(async () => {
  app = await build(); me = await createAccount(app); nobody = await createAccount(app);
  await app.pg.writer.query(`UPDATE userlogin SET email = 'dummy@example.com', loginused = 'apple' WHERE userid = $1`, [me.userid]);
  await app.pg.writer.query(
    `INSERT INTO userinfo (userid, dateregistered, dobglobal, height, weight, seconds_from_gmt, hideprofile, gender, iso, fname, lname, city, state, lat, lon, geom, about, timezone, store_id, mailids)
     VALUES ($1, 1665014400, 252460800, 172.7, 70.5, 3600, false, 'male', 'DK', 'Dum', 'My', 'Copenhagen', 'Capital', 55.62913, 12.48244, ST_MakePoint(12.48244, 55.62913), 'About me', 'Europe/Copenhagen', gen_random_uuid(), 'Ab3dE5gH7jK')`, [me.userid]);
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
    dateregistered: 1665014400, last_access_date: expect.any(Number), geo_source: null, mailids: 'Ab3dE5gH7jK',
  });
  expect(account).toEqual({ email: 'dummy@example.com', loginused: 'apple' });
  for (const hidden of ['geom', 'store_id', 'userid', 'deleted_date']) expect(profile).not.toHaveProperty(hidden);
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

test('the support reference (mailids): 11 letters and digits, made with the profile, never changed, and given to an older row on the first read', async () => {
  expect(generateMailids()).toMatch(/^[A-Za-z0-9]{11}$/);
  expect(new Set(Array.from({ length: 50 }, generateMailids)).size).toBe(50);

  // A new profile gets one, and the put answers it.
  const made = await phoneProfilePut(app, nobody.phoneToken, { fname: 'Nova' });
  expect(made.json().mailids).toMatch(/^[A-Za-z0-9]{11}$/);
  const first = (await get('/phone/v3/profile', nobody.phoneToken)).json().profile.mailids;
  expect(first).toBe(made.json().mailids);

  // Later puts and reads leave it as it was.
  await phoneProfilePut(app, nobody.phoneToken, { fname: 'Nova', about: 'changed' });
  expect((await get('/phone/v3/profile', nobody.phoneToken)).json().profile.mailids).toBe(first);

  // A row from before it existed gets one at the first read, then keeps it.
  await app.pg.writer.query('UPDATE userinfo SET mailids = NULL WHERE userid = $1', [nobody.userid]);
  const given = (await get('/phone/v3/profile', nobody.phoneToken)).json().profile.mailids;
  expect(given).toMatch(/^[A-Za-z0-9]{11}$/);
  expect((await get('/phone/v3/profile', nobody.phoneToken)).json().profile.mailids).toBe(given);
});
