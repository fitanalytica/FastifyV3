import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { registerDownload } from '../../src/services/auth/downloads.js';
import { setGeoSources, type GeoSources, type IpPlace } from '../../src/services/location/ipToGeo.js';
import { phoneDevice, phoneProfilePut } from '../helpers/viaSync.js';

// The first-download place (docs/data/server.md section 7, rule 1) and the device data (docs/data/api.md section 1d): what `downloads` holds about an install.
let app: TestApp;
let a: Account;
const PUNE: IpPlace = { iso: 'IN', city: 'Pune', state: 'Maharashtra', lat: 18.5, lon: 73.8 };
const NICE: IpPlace = { iso: 'FR', city: 'Nice', state: null, lat: 43.7, lon: 7.26 };
const IP_A = '203.0.113.9';
const IP_B = '198.51.100.7';
let places: Record<string, IpPlace | null>;
const local = vi.fn(async (ip: string) => places[ip] ?? null);
const sources: GeoSources = { local, web: vi.fn(async () => null) };
const made: string[] = [];

const download = async (id: string) => (await app.pg.writer.query('SELECT * FROM downloads WHERE downloadid = $1', [id])).rows[0];
const fresh = () => {
  const id = randomUUID();
  made.push(id);
  return id;
};
const INFO = { os: '17.4', appVersion: '1.4.0', model: 'iPhone', code: 'iPhone16,1', manufacturer: 'Apple', timezone: 'Asia/Kolkata', region: 'IN' };

beforeAll(async () => {
  app = await build();
  a = await createAccount(app);
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  await app.pg.writer.query('DELETE FROM downloads WHERE downloadid = ANY($1)', [made]);
  await a.remove();
  await app.close();
});
beforeEach(() => {
  places = { [IP_A]: PUNE, [IP_B]: NICE };
  local.mockClear();
  setGeoSources(sources);
});
afterEach(() => setGeoSources(undefined));

test('a new install: its device data and the place of its IP address are kept (the first-download lookup)', async () => {
  const id = fresh();
  await registerDownload(app, { downloadid: id, userid: a.userid, platform: 'ios', info: INFO, ip: IP_A });
  expect(await download(id)).toMatchObject({
    userid: a.userid, device_type: 'phone', platform: 'ios', device_os: '17.4', appversion: '1.4.0', device_code: 'iPhone16,1', device_manufacturer: 'Apple', device_model: 'iPhone',
    timezone: 'Asia/Kolkata', iso: 'IN', city: 'Pune', state: 'Maharashtra',
  });
});

test('the place is found once: a repeat sign-in from another address does not change it, and the lookup is not repeated', async () => {
  const id = fresh();
  await registerDownload(app, { downloadid: id, userid: a.userid, platform: 'ios', info: INFO, ip: IP_A });
  local.mockClear();
  await registerDownload(app, { downloadid: id, userid: a.userid, platform: 'ios', info: { ...INFO, appVersion: '1.5.0' }, ip: IP_B });
  expect(local).not.toHaveBeenCalled();
  expect(await download(id)).toMatchObject({ iso: 'IN', city: 'Pune', appversion: '1.5.0' });
});

test('a repeat keeps what it does not carry, changes what it does, and moves last_access_date', async () => {
  const id = fresh();
  await registerDownload(app, { downloadid: id, userid: a.userid, info: INFO, ip: IP_A });
  await app.pg.writer.query('UPDATE downloads SET last_access_date = 1000 WHERE downloadid = $1', [id]);
  await registerDownload(app, { downloadid: id, userid: a.userid, info: { os: '17.5' }, ip: IP_A });
  const r = await download(id);
  expect(r).toMatchObject({ device_os: '17.5', appversion: '1.4.0', device_model: 'iPhone', timezone: 'Asia/Kolkata' });
  expect(r.last_access_date).toBeGreaterThan(1_700_000_000);
});

test('a text longer than its column is cut, not refused; an empty one is nothing', async () => {
  const id = fresh();
  await registerDownload(app, { downloadid: id, userid: a.userid, info: { os: '17.4.1.12345', appVersion: '1.4.0.99999', model: ' ', manufacturer: 'A'.repeat(150) } });
  expect(await download(id)).toMatchObject({ device_os: '17.4.1.123', appversion: '1.4.0.9999', device_model: null });
  expect((await download(id)).device_manufacturer).toHaveLength(100);
});

test('the IP lookup has no answer: the device region is the first guess for the country, with no city', async () => {
  const id = fresh();
  places = {};
  await registerDownload(app, { downloadid: id, userid: a.userid, info: { region: 'fr' }, ip: IP_A });
  expect(await download(id)).toMatchObject({ iso: 'FR', city: null, state: null });
});

test('no place, no region (a private address): the place stays empty and the sign-in is fine; a region the server does not know is ignored', async () => {
  const id = fresh();
  await registerDownload(app, { downloadid: id, userid: a.userid, info: { region: 'ZZ' }, ip: '127.0.0.1' });
  expect(await download(id)).toMatchObject({ iso: null, city: null });
});

test("a watch's row is the same: its own device data and place", async () => {
  const id = fresh();
  await registerDownload(app, { downloadid: id, userid: a.userid, watch: true, info: INFO, ip: IP_A });
  expect(local).toHaveBeenCalledWith(IP_A);
  expect(await download(id)).toMatchObject({ device_type: 'watch', platform: 'watchos', iso: 'IN', device_os: '17.4' });
});

const put = (body: unknown, token = a.phoneToken, ip = IP_A) => phoneDevice(app, token, body, { ip });

test("PUT /device: changes the phone's own install, 204", async () => {
  const before = await download(a.phoneDownloadid);
  expect(before.device_os).toBeNull();
  const res = await put({ os: '18.0', appVersion: '2.0.0', timezone: 'Europe/Paris', fcmToken: 'tok-123' });
  expect(res.statusCode).toBe(204);
  expect(await download(a.phoneDownloadid)).toMatchObject({ device_os: '18.0', appversion: '2.0.0', timezone: 'Europe/Paris', fcm_token: 'tok-123', device_type: 'phone' });
  // The watch's row is not touched.
  expect((await download(a.watchDownloadid)).device_os).toBeNull();
});

test('PUT /device: an install with no place yet is looked up now; one that has it is not looked up again', async () => {
  await app.pg.writer.query('UPDATE downloads SET iso = NULL, city = NULL, state = NULL WHERE downloadid = $1', [a.phoneDownloadid]);
  await put({ os: '18.1' }, a.phoneToken, IP_B);
  expect(await download(a.phoneDownloadid)).toMatchObject({ iso: 'FR', city: 'Nice' });
  local.mockClear();
  await put({ os: '18.2' }, a.phoneToken, IP_A);
  expect(local).not.toHaveBeenCalled();
  expect(await download(a.phoneDownloadid)).toMatchObject({ iso: 'FR', device_os: '18.2' });
});

test('PUT /device: the watch token is refused, a bad region is a 400, and nothing is needed in the body', async () => {
  expect((await put({ os: '1' }, a.watchToken)).statusCode).toBe(403);
  expect((await put({ region: 'India' })).statusCode).toBe(400);
  expect((await put({})).statusCode).toBe(204);
});

// A new profile starts with a place (docs/data/server.md section 7, rule 1).
const putProfile = (body: unknown, ip: string) => phoneProfilePut(app, a.phoneToken, body, { ip });
const profileRow = async () => (await app.pg.writer.query('SELECT iso, city, state, lat, lon, geo_source FROM userinfo WHERE userid = $1', [a.userid])).rows[0];

test('a new profile starts with the place of its IP address, source IP; an existing profile keeps its own place', async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  expect((await putProfile({ fname: 'Asha' }, IP_A)).statusCode).toBe(200);
  expect(await profileRow()).toMatchObject({ iso: 'IN', city: 'Pune', state: 'Maharashtra', geo_source: 1 });
  expect(Number((await profileRow()).lat)).toBeCloseTo(18.5, 1);
  await putProfile({ weight: 60 }, IP_B);
  expect(await profileRow()).toMatchObject({ iso: 'IN', city: 'Pune' });
});

test("a new profile with no lookup answer starts with the place of the user's install, with no coordinates", async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  // The user's other installs (made by the tests above) have no place here: the latest with one is this.
  await app.pg.writer.query('UPDATE downloads SET iso = NULL, city = NULL, state = NULL WHERE userid = $1', [a.userid]);
  await app.pg.writer.query(`UPDATE downloads SET iso = 'DE', city = 'Bonn' WHERE downloadid = $1`, [a.phoneDownloadid]);
  places = {};
  await putProfile({ fname: 'Asha' }, IP_A);
  const r = await profileRow();
  expect(r).toMatchObject({ iso: 'DE', city: 'Bonn', geo_source: 1 });
  expect(r.lat).toBeNull();
});

test('a new profile with no place anywhere is made without one', async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  await app.pg.writer.query('UPDATE downloads SET iso = NULL, city = NULL WHERE userid = $1', [a.userid]);
  places = {};
  expect((await putProfile({ fname: 'Asha' }, '127.0.0.1')).statusCode).toBe(200);
  expect(await profileRow()).toMatchObject({ iso: null, city: null });
});
