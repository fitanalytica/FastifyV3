import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ipToGeo, isPublicIp, placeFrom, type GeoSources, type IpPlace } from '../../../src/services/location/ipToGeo.js';

// docs/data/server.md section 7: the place of an IP address. The local database answers first, the web service when it cannot; nothing throws; never (0, 0).
const PUNE: IpPlace = { iso: 'IN', city: 'Pune', state: 'Maharashtra', lat: 18.5, lon: 73.8 };
const NICE: IpPlace = { iso: 'FR', city: 'Nice', state: null, lat: 43.7, lon: 7.26 };
const sources = (local: IpPlace | null, web: IpPlace | null) => ({ local: vi.fn(async () => local), web: vi.fn(async () => web) }) satisfies GeoSources;

test('a record from MaxMind becomes a place: names in English, the country checked against the server list, the coordinates as numbers', () => {
  expect(placeFrom({ country: { iso_code: 'in' }, city: { names: { en: ' Pune ' } }, subdivisions: [{ names: { en: 'Maharashtra' } }], location: { latitude: 18.5, longitude: '73.8' } })).toEqual(PUNE);
  expect(placeFrom({ country: { isoCode: 'FR' }, location: { latitude: 43.7, longitude: 7.26 } })).toMatchObject({ iso: 'FR', city: null, state: null });
});

test('no country the server knows, no place; no coordinates, or (0, 0), are null and never 0', () => {
  expect(placeFrom(null)).toBeNull();
  expect(placeFrom({ city: { names: { en: 'X' } } })).toBeNull();
  expect(placeFrom({ country: { iso_code: 'ZZ' } })).toBeNull();
  expect(placeFrom({ country: { iso_code: 'IN' }, location: { latitude: 0, longitude: 0 } })).toMatchObject({ lat: null, lon: null });
  expect(placeFrom({ country: { iso_code: 'IN' }, location: { latitude: 12 } })).toMatchObject({ lat: null, lon: null });
});

test('only a public address is looked up', () => {
  for (const ip of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8']) expect(isPublicIp(ip), ip).toBe(true);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', 'not an ip', '', '224.0.0.1', '0.0.0.0']) expect(isPublicIp(ip), ip).toBe(false);
});

test('the local database answers first: the web service is not asked', async () => {
  const s = sources(PUNE, NICE);
  await expect(ipToGeo('8.8.8.8', s)).resolves.toEqual(PUNE);
  expect(s.web).not.toHaveBeenCalled();
});

test('when the database has no answer (no file, an address it does not have) the web service answers', async () => {
  const s = sources(null, NICE);
  await expect(ipToGeo('8.8.4.4', s)).resolves.toEqual(NICE);
  expect(s.local).toHaveBeenCalledWith('8.8.4.4');
  expect(s.web).toHaveBeenCalledWith('8.8.4.4');
});

test('neither knows it: null, not an error', async () => {
  await expect(ipToGeo('8.8.4.4', sources(null, null))).resolves.toBeNull();
});

test('a private address is never looked up, and an IPv4-mapped one is looked up as IPv4', async () => {
  const s = sources(PUNE, NICE);
  await expect(ipToGeo('192.168.1.4', s)).resolves.toBeNull();
  expect(s.local).not.toHaveBeenCalled();
  await ipToGeo('::ffff:8.8.8.8', s);
  expect(s.local).toHaveBeenCalledWith('8.8.8.8');
});

beforeEach(() => vi.stubEnv('GEOIP_DB_PATH', ''));
afterEach(() => vi.unstubAllEnvs());
