import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { setGeoSources, type GeoSources, type IpPlace } from '../../src/services/location/ipToGeo.js';
import { IPREF_MAX_AGE_SECONDS, makeIpref } from '../../src/services/location/ipref.js';
import { env } from '../../src/config/env.js';
import { probe } from '../helpers/viaSync.js';

// A phone with location off has its place from the IP address (docs/data/server.md section 7, rule 4): looked up when the address changes, never kept.
let app: TestApp;
let a: Account;
const PUNE: IpPlace = { iso: 'IN', city: 'Pune', state: 'Maharashtra', lat: 18.5, lon: 73.8 };
const NICE: IpPlace = { iso: 'FR', city: 'Nice', state: null, lat: 43.7, lon: 7.26 };
const IP_A = '203.0.113.9';
const IP_B = '198.51.100.7';
const NOW = () => Math.floor(Date.now() / 1000);

let places: Record<string, IpPlace | null>;
const local = vi.fn(async (ip: string) => places[ip] ?? null);
const web = vi.fn(async () => null);
const sources: GeoSources = { local, web };

const call = (ip: string, headers: Record<string, string> = {}) => probe(app, a.phoneToken, { ip, headers });
const place = async () => (await app.pg.writer.query('SELECT iso, city, state, lat, lon, geo_source FROM userinfo WHERE userid = $1', [a.userid])).rows[0];

beforeAll(async () => {
  app = await build();
  a = await createAccount(app);
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, seconds_from_gmt, dateregistered, iso, city, geo_source, lat, lon) VALUES ($1, 'Pat', 0, 1700000000, 'US', 'Austin', 2, 30.2, -97.7)`, [a.userid]);
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  await a.remove();
  await app.close();
});
beforeEach(() => {
  places = { [IP_A]: PUNE, [IP_B]: NICE };
  local.mockClear();
  web.mockClear();
  setGeoSources(sources);
});
afterEach(() => setGeoSources(undefined));

test('location off and no ipref (the first request): the address is looked up, the place is saved from it (the IP is the source, even over the GPS one), and an ipref comes back', async () => {
  const res = await call(IP_A, { 'x-location': 'off' });
  expect(res.statusCode).toBe(200);
  expect(local).toHaveBeenCalledWith(IP_A);
  expect(await place()).toMatchObject({ iso: 'IN', city: 'Pune', state: 'Maharashtra', geo_source: 1 });
  const ipref = String(res.headers.ipref);
  expect(ipref).toMatch(/^\d+\.[0-9a-f]{32}$/);
  expect(ipref).not.toContain(IP_A);
});

test('the same address with its ipref: nothing is looked up, and the same ipref stays', async () => {
  const ipref = makeIpref(IP_A, NOW() - 60, env().iprefKey);
  const res = await call(IP_A, { 'x-location': 'off', 'x-ipref': ipref });
  expect(local).not.toHaveBeenCalled();
  expect(res.headers.ipref).toBe(ipref);
});

test('a different address within a day is ignored; after a day it is looked up and the place changes', async () => {
  const fresh = makeIpref(IP_A, NOW() - 3600, env().iprefKey);
  const ignored = await call(IP_B, { 'x-location': 'off', 'x-ipref': fresh });
  expect(local).not.toHaveBeenCalled();
  expect(ignored.headers.ipref).toBe(fresh);
  expect((await place()).iso).toBe('IN');

  const old = makeIpref(IP_A, NOW() - IPREF_MAX_AGE_SECONDS - 5, env().iprefKey);
  const changed = await call(IP_B, { 'x-location': 'off', 'x-ipref': old });
  expect(local).toHaveBeenCalledWith(IP_B);
  expect(await place()).toMatchObject({ iso: 'FR', city: 'Nice', state: null, geo_source: 1 });
  expect(changed.headers.ipref).not.toBe(old);
});

test('location on, or no header (the watch, an older app): the IP is not looked up, nothing changes, no ipref', async () => {
  await app.pg.writer.query(`UPDATE userinfo SET iso = 'US', city = 'Austin', geo_source = 2 WHERE userid = $1`, [a.userid]);
  for (const headers of [{ 'x-location': 'on' }, {}] as Array<Record<string, string>>) {
    const res = await call(IP_A, headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers.ipref).toBeUndefined();
  }
  expect(local).not.toHaveBeenCalled();
  expect(await place()).toMatchObject({ iso: 'US', city: 'Austin', geo_source: 2 });
});

test('a failed lookup blocks nothing and changes nothing; the ipref still goes out, so it is not tried at every request', async () => {
  await app.pg.writer.query(`UPDATE userinfo SET iso = 'US', city = 'Austin', geo_source = 2 WHERE userid = $1`, [a.userid]);
  places = {};
  const res = await call(IP_A, { 'x-location': 'off' });
  expect(res.statusCode).toBe(200);
  expect(await place()).toMatchObject({ iso: 'US', city: 'Austin', geo_source: 2 });
  expect(String(res.headers.ipref)).toMatch(/^\d+\.[0-9a-f]{32}$/);
});

test('a private address has no place: nothing is changed', async () => {
  await app.pg.writer.query(`UPDATE userinfo SET iso = 'US', city = 'Austin', geo_source = 2 WHERE userid = $1`, [a.userid]);
  const res = await call('127.0.0.1', { 'x-location': 'off' });
  expect(res.statusCode).toBe(200);
  expect(local).not.toHaveBeenCalled();
  expect((await place()).iso).toBe('US');
});

test('the same place found again writes nothing new (the update only runs when the place really changed)', async () => {
  await call(IP_B, { 'x-location': 'off' });
  await app.pg.writer.query(`UPDATE userinfo SET lat = 1.5 WHERE userid = $1`, [a.userid]);
  await call(IP_B, { 'x-location': 'off' });
  expect(Number((await place()).lat)).toBeCloseTo(1.5, 1);
});

test('without the ipref flag a user with no profile row is fine too: the update touches nothing and the request is answered', async () => {
  const lone = await createAccount(app);
  const res = await probe(app, lone.phoneToken, { ip: IP_A, headers: { 'x-location': 'off' } });
  expect(res.statusCode).toBe(200);
  expect(res.headers.ipref).toBeDefined();
  await lone.remove();
});
