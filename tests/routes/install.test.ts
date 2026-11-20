import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { registerDownload } from '../../src/services/auth/downloads.js';
import { setGeoSources, type GeoSources, type IpPlace } from '../../src/services/location/ipToGeo.js';
import { probe, probeWatch } from '../helpers/viaSync.js';

// The install's first call (docs/data/api.md section 1d): made when the app is first opened, before anyone signs in; the place of its IP address is the first payload.
let app: TestApp;
let a: Account;
const PUNE: IpPlace = { iso: 'IN', city: 'Pune', state: 'Maharashtra', lat: 18.5, lon: 73.8 };
const IP_A = '203.0.113.9';
const IP_B = '198.51.100.7';
let places: Record<string, IpPlace | null>;
const local = vi.fn(async (ip: string) => places[ip] ?? null);
const sources: GeoSources = { local, web: vi.fn(async () => null) };
const madeDownloads: string[] = [];
const madeDevices: string[] = [];
const INFO = { os: '17.4', appVersion: '1.4.0', model: 'iPhone', code: 'iPhone16,1', manufacturer: 'Apple', timezone: 'Asia/Kolkata', region: 'IN' };

const row = async (id: string) => (await app.pg.writer.query('SELECT * FROM downloads WHERE downloadid = $1', [id])).rows[0];
const ids = () => {
  const downloadid = randomUUID();
  const deviceid = randomUUID();
  madeDownloads.push(downloadid);
  madeDevices.push(deviceid);
  return { downloadid, deviceid };
};
const call = (url: string, body: unknown, ip = IP_A) => app.inject({ method: 'POST', url, remoteAddress: ip, payload: body as object });

beforeAll(async () => {
  process.env.LOGIN_RATE_LIMIT = '1000';
  app = await build();
  a = await createAccount(app);
});
afterAll(async () => {
  delete process.env.LOGIN_RATE_LIMIT;
  await app.pg.writer.query('DELETE FROM usertokens WHERE deviceid = ANY($1)', [madeDevices]);
  await app.pg.writer.query('DELETE FROM downloads WHERE downloadid = ANY($1)', [madeDownloads]);
  await a.remove();
  await app.close();
});
beforeEach(() => {
  places = { [IP_A]: PUNE };
  local.mockClear();
  setGeoSources(sources);
});
afterEach(() => setGeoSources(undefined));

test('a phone that has never signed in: its row is made, with no owner, its download id and device id, its device data and the place of its IP address; the place comes back as the first payload', async () => {
  const i = ids();
  const res = await call('/phone/v3/download', { ...i, platform: 'ios', deviceInfo: INFO });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ downloadid: i.downloadid, place: { iso: 'IN', city: 'Pune', state: 'Maharashtra', country: 'India', lat: 18.5, lon: 73.8 } });
  expect(await row(i.downloadid)).toMatchObject({
    userid: null, deviceid: i.deviceid, device_type: 'phone', platform: 'ios', device_os: '17.4', appversion: '1.4.0', device_code: 'iPhone16,1', device_manufacturer: 'Apple',
    device_model: 'iPhone', timezone: 'Asia/Kolkata', iso: 'IN', city: 'Pune', state: 'Maharashtra',
  });
});

test('a repeat (the app opened again before signing in) brings the row up to date and answers the same place, without looking it up again', async () => {
  const i = ids();
  await call('/phone/v3/download', { ...i, deviceInfo: INFO });
  local.mockClear();
  const res = await call('/phone/v3/download', { ...i, deviceInfo: { appVersion: '1.5.0' } }, IP_B);
  expect(local).not.toHaveBeenCalled();
  expect(res.json().place).toMatchObject({ iso: 'IN', city: 'Pune', country: 'India', lat: null, lon: null });
  expect(await row(i.downloadid)).toMatchObject({ appversion: '1.5.0', device_os: '17.4', iso: 'IN' });
});

test("no place for the address (a private one) and no region: the row is made, the first payload's place is null", async () => {
  const i = ids();
  const res = await call('/phone/v3/download', i, '127.0.0.1');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ downloadid: i.downloadid, place: null });
  expect(await row(i.downloadid)).toMatchObject({ userid: null, iso: null });
});

test('the device region is the first guess when the lookup finds nothing', async () => {
  const i = ids();
  places = {};
  const res = await call('/phone/v3/download', { ...i, deviceInfo: { region: 'fr' } });
  expect(res.json().place).toMatchObject({ iso: 'FR', city: null, country: 'France' });
});

test('then the user signs in: the same row gets the user id (and keeps its place and device data); a call with no owner never clears one', async () => {
  const i = ids();
  await call('/phone/v3/download', { ...i, deviceInfo: INFO });
  await registerDownload(app, { downloadid: i.downloadid, userid: a.userid, deviceid: i.deviceid, info: { appVersion: '1.5.0' } });
  expect(await row(i.downloadid)).toMatchObject({ userid: a.userid, deviceid: i.deviceid, iso: 'IN', city: 'Pune', device_os: '17.4', appversion: '1.5.0' });
  await call('/phone/v3/download', i);
  expect((await row(i.downloadid)).userid).toBe(a.userid);
});

test("the watch's install is the same, with its own row", async () => {
  const i = ids();
  const res = await call('/wearable/v3/download', { ...i, platform: 'ios', deviceInfo: { os: '10.4', model: 'Watch' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().place).toMatchObject({ iso: 'IN' });
  expect(await row(i.downloadid)).toMatchObject({ userid: null, device_type: 'watch', platform: 'watchos', deviceid: i.deviceid, device_os: '10.4' });
});

test('it is public, validated and limited: no token is needed, a bad id or region is a 400, and an address is limited as the sign-in is', async () => {
  expect((await call('/phone/v3/download', { downloadid: 'nope', deviceid: randomUUID() })).statusCode).toBe(400);
  expect((await call('/phone/v3/download', { ...ids(), deviceInfo: { region: 'India' } })).statusCode).toBe(400);
  expect((await call('/phone/v3/download', {})).statusCode).toBe(400);
  process.env.LOGIN_RATE_LIMIT = '2';
  const limited = await build();
  try {
    const codes: number[] = [];
    for (let n = 0; n < 4; n++) {
      const i = ids();
      codes.push((await limited.inject({ method: 'POST', url: '/phone/v3/download', remoteAddress: '203.0.113.55', payload: i })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
  } finally {
    process.env.LOGIN_RATE_LIMIT = '1000';
    await limited.close();
  }
});

// The watch gets its own sign-in from the phone: its row gets the user id the moment its tokens are made.
const watchToken = (body: unknown, token = a.phoneToken) => app.inject({ method: 'POST', url: '/phone/v3/auth/watch-token', headers: bearer(token), payload: body as object });

test("the phone gives the watch its tokens: the watch's row (made at its install, no owner) gets the user id, the phone's row says a watch is paired, and the tokens are the watch's own", async () => {
  const i = ids();
  await call('/wearable/v3/download', { ...i, deviceInfo: { os: '10.4' } });
  expect((await row(i.downloadid)).userid).toBeNull();
  const res = await watchToken({ ...i, device: 'Apple Watch' });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body).toMatchObject({ userid: a.userid, downloadid: i.downloadid });
  expect(await row(i.downloadid)).toMatchObject({ userid: a.userid, device_type: 'watch', deviceid: i.deviceid, device_os: '10.4', iso: 'IN' });
  expect((await row(a.phoneDownloadid)).is_watch_paired).toBe(true);
  // The watch token works on the watch's routes only.
  expect((await probeWatch(app, body.accessToken)).statusCode).toBe(200);
  expect((await probe(app, body.accessToken)).statusCode).toBe(403);
  // And the phone's own token still works.
  expect((await probe(app, a.phoneToken)).statusCode).toBe(200);
});

test('a watch that never called in gets its row now, owned from the start; the same watch again changes nothing but the tokens', async () => {
  const i = ids();
  const first = await watchToken({ ...i, platform: 'ios' });
  expect(first.statusCode).toBe(200);
  expect(await row(i.downloadid)).toMatchObject({ userid: a.userid, device_type: 'watch', platform: 'watchos' });
  const again = await watchToken(i);
  expect(again.statusCode).toBe(200);
  expect(again.json().accessToken).not.toBe(first.json().accessToken);
  expect((await app.pg.writer.query('SELECT count(*)::int AS n FROM downloads WHERE downloadid = $1', [i.downloadid])).rows[0].n).toBe(1);
});

test("the watch's device id must not be the phone's (one token row per device id: it would sign the phone out), and the watch cannot ask for its own token", async () => {
  const phoneDevice = (await app.pg.writer.query('SELECT deviceid FROM usertokens WHERE userid = $1 AND downloadid = $2', [a.userid, a.phoneDownloadid])).rows[0].deviceid as string;
  expect((await watchToken({ deviceid: phoneDevice })).statusCode).toBe(400);
  expect((await watchToken(ids(), a.watchToken)).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/phone/v3/auth/watch-token', payload: ids() })).statusCode).toBeGreaterThanOrEqual(400);
});
