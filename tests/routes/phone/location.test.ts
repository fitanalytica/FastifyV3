import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { bearer } from '../../helpers/fixtures.js';
import { phoneLocation } from '../../helpers/viaSync.js';

let app: TestApp;
let me: Account, nobody: Account, bystander: Account;
const PLACE = { lat: 55.629131, lon: 12.482441, city: 'Copenhagen', state: 'Capital Region', iso: 'DK' };

beforeAll(async () => {
  app = await build(); me = await createAccount(app); nobody = await createAccount(app); bystander = await createAccount(app);
  for (const [acc, name] of [[me, 'Dum'], [bystander, 'Other']] as const) {
    await app.pg.writer.query(
      `INSERT INTO userinfo (userid, dateregistered, dobglobal, height, weight, gender, fname, lat, lon, city, state, iso, geo_source, geom)
       VALUES ($1, 1665014400, 252460800, 172.7, 70.5, 'male', $2, 19.11927, 72.89425, 'Mumbai', 'Maharashtra', 'IN', 1, ST_MakePoint(72.89425, 19.11927))`, [acc.userid, name]);
  }
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[me.userid, bystander.userid]]);
  await me.remove(); await nobody.remove(); await bystander.remove(); await app.close();
});

const put = (token: string | null, payload: unknown, url?: string) =>
  url ? app.inject({ method: 'PUT', url, headers: token ? bearer(token) : {}, payload: payload as object }) : phoneLocation(app, token, payload);
const row = async (userid: string) => (await app.pg.writer.query(
  'SELECT lat, lon, city, state, iso, geo_source, geom[0] AS gx, geom[1] AS gy, fname, gender, height, weight, dobglobal, dateregistered FROM userinfo WHERE userid = $1', [userid])).rows[0];

test('saves the place: the columns, the exact point in geom (longitude first), the source GPS; the reply names the country', async () => {
  const res = await put(me.phoneToken, PLACE);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ...PLACE, country: 'Denmark' });
  const r = await row(me.userid);
  expect(r).toMatchObject({ city: 'Copenhagen', state: 'Capital Region', iso: 'DK', geo_source: 2 });
  expect(r.lat).toBeCloseTo(55.629131, 4);               // REAL: about 7 digits
  expect(r.lon).toBeCloseTo(12.482441, 4);
  expect(r.gy).toBeCloseTo(55.629131, 9);                 // geom keeps the exact doubles
  expect(r.gx).toBeCloseTo(12.482441, 9);
});

test('it replaces the place that was there (a row that was by IP becomes GPS), and a later move replaces it again', async () => {
  await put(me.phoneToken, { ...PLACE, lat: 19.11927, lon: 72.89425, city: 'Mumbai', state: 'Maharashtra', iso: 'IN' });
  expect(await row(me.userid)).toMatchObject({ city: 'Mumbai', iso: 'IN', geo_source: 2 });
  const res = await put(me.phoneToken, PLACE);
  expect(res.json().country).toBe('Denmark');
  expect(await row(me.userid)).toMatchObject({ city: 'Copenhagen', iso: 'DK' });
});

test('the country code is normalised to upper case; city and state are trimmed; a missing or empty state is none', async () => {
  const lower = await put(me.phoneToken, { ...PLACE, iso: 'dk', city: '  Copenhagen ', state: ' Capital Region  ' });
  expect(lower.json()).toMatchObject({ iso: 'DK', city: 'Copenhagen', state: 'Capital Region', country: 'Denmark' });
  for (const state of [undefined, '', '   ']) {
    const { state: _, ...rest } = PLACE;
    const res = await put(me.phoneToken, state === undefined ? { ...rest, iso: 'SG', city: 'Singapore', lat: 1.3521, lon: 103.8198 } : { ...rest, state, iso: 'SG', city: 'Singapore', lat: 1.3521, lon: 103.8198 });
    expect(res.json()).toMatchObject({ state: null, country: 'Singapore' });
    expect((await row(me.userid)).state).toBeNull();
  }
});

test('a long city or state is cut to the 50 characters of the columns, in the reply too', async () => {
  const long = 'X'.repeat(90);
  const res = await put(me.phoneToken, { ...PLACE, city: long, state: long });
  expect(res.statusCode).toBe(200);
  expect(res.json().city).toHaveLength(50);
  expect((await row(me.userid)).city).toHaveLength(50);
  expect((await row(me.userid)).state).toHaveLength(50);
});

test('only the place changes: nothing else of the profile, and nobody else\'s row', async () => {
  const before = await row(bystander.userid);
  await put(me.phoneToken, PLACE);
  const r = await row(me.userid);
  expect(r).toMatchObject({ fname: 'Dum', gender: 'male', height: 172.7, weight: 70.5, dobglobal: 252460800, dateregistered: 1665014400 });
  expect(await row(bystander.userid)).toEqual(before);
});

test('a place that cannot be right is a 400, and the stored place is left as it was', async () => {
  await put(me.phoneToken, PLACE);
  const before = await row(me.userid);
  const bad: [string, unknown][] = [
    ['latitude over 90', { ...PLACE, lat: 90.5 }],
    ['longitude over 180', { ...PLACE, lon: -181 }],
    ['not a number', { ...PLACE, lat: 'north' }],
    ['no city', (({ city: _, ...r }) => r)(PLACE)],
    ['an empty city', { ...PLACE, city: '' }],
    ['a city of spaces', { ...PLACE, city: '   ' }],
    ['no country code', (({ iso: _, ...r }) => r)(PLACE)],
    ['a code of one letter', { ...PLACE, iso: 'D' }],
    ['a code of three letters', { ...PLACE, iso: 'DKK' }],
    ['a code that is not a country', { ...PLACE, iso: 'XX' }],
    ['(0, 0), what a failed fix looks like', { ...PLACE, lat: 0, lon: 0 }],
    ['no body', {}],
  ];
  for (const [what, payload] of bad) {
    const res = await put(me.phoneToken, payload);
    expect(res.statusCode, what).toBe(400);
    expect(res.json().code, what).toBe('BAD_REQUEST');
  }
  expect(await row(me.userid)).toEqual(before);
});

test('(0, 0) is refused but a point on the equator or on the meridian is a place', async () => {
  expect((await put(me.phoneToken, { ...PLACE, lat: 0, lon: 36.8, city: 'Nairobi', iso: 'KE' })).statusCode).toBe(200);
  expect((await put(me.phoneToken, { ...PLACE, lat: 51.4, lon: 0, city: 'Greenwich', iso: 'GB' })).statusCode).toBe(200);
});

test('a user with no profile row yet is a 404, routine and not logged, and nothing is made', async () => {
  const res = await put(nobody.phoneToken, PLACE);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  expect((await app.pg.writer.query('SELECT count(*)::int n FROM userinfo WHERE userid = $1', [nobody.userid])).rows[0].n).toBe(0);
});

test('it is the phone\'s: a token is needed, a watch token is refused, and the watch has no such route', async () => {
  expect((await put(null, PLACE)).json().code).toBe('INVALID_TOKEN_FORMAT');
  expect((await put(me.watchToken, PLACE)).json().code).toBe('WRONG_DEVICE');
  expect((await put(me.watchToken, PLACE, '/wearable/v3/profile/location')).json().code).toBe('NOT_FOUND');
  expect((await put('a.b.c', PLACE)).json().code).toBe('LOGOUT');
});

test('GET /profile names the country from the code, and has none when there is no place', async () => {
  await put(me.phoneToken, PLACE);
  const got = (token: string) => app.inject({ url: '/phone/v3/profile', headers: bearer(token) });
  expect((await got(me.phoneToken)).json().profile).toMatchObject({ iso: 'DK', city: 'Copenhagen', country: 'Denmark' });
  await app.pg.writer.query('UPDATE userinfo SET iso = NULL, city = NULL WHERE userid = $1', [bystander.userid]);
  expect((await got(bystander.phoneToken)).json().profile).toMatchObject({ iso: null, country: null });
  await app.pg.writer.query(`UPDATE userinfo SET iso = 'ZZ' WHERE userid = $1`, [bystander.userid]);
  expect((await got(bystander.phoneToken)).json().profile).toMatchObject({ iso: 'ZZ', country: null });   // a code the list does not have: no name, no crash
});
