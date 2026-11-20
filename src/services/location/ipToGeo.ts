import net from 'node:net';
import { WebServiceClient } from '@maxmind/geoip2-node';
import maxmind, { type Reader } from 'maxmind';
import { env } from '../../config/env.js';
import { isCountryCode } from './countries.js';

// docs/data/server.md section 7: the place of an IP address, for a user whose location is off. The local MaxMind database (GeoLite2-City, an .mmdb file read into memory once: no disk read
// per request) answers first; when it cannot (no file, an address it does not have), the MaxMind web service does. Nothing here throws: a failed lookup is `null`, the place stays unknown
// (never 0, 0) and nothing else is blocked.

export interface IpPlace {
  /** Upper case, 2 letters, in the server's list of countries. */
  iso: string;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
}

/** The two sources, so a test can pass its own. Each answers a place, or `null` when it has none. */
export interface GeoSources {
  local: (ip: string) => Promise<IpPlace | null>;
  web: (ip: string) => Promise<IpPlace | null>;
}

interface CityLike {
  country?: { iso_code?: string; isoCode?: string };
  city?: { names?: { en?: string } };
  subdivisions?: Array<{ names?: { en?: string } }>;
  location?: { latitude?: number | string; longitude?: number | string };
}

const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
const number = (v: number | string | undefined) => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** A place from what MaxMind answered (either source). `null` without a country the server knows: a place without a country is no place. Coordinates are `null` when absent, never 0. */
export function placeFrom(geo: CityLike | null | undefined): IpPlace | null {
  const iso = (geo?.country?.iso_code ?? geo?.country?.isoCode ?? '').toUpperCase();
  if (!isCountryCode(iso)) return null;
  const lat = number(geo?.location?.latitude);
  const lon = number(geo?.location?.longitude);
  const both = lat !== null && lon !== null && !(lat === 0 && lon === 0);
  return { iso, city: text(geo?.city?.names?.en), state: text(geo?.subdivisions?.[0]?.names?.en), lat: both ? lat : null, lon: both ? lon : null };
}

/** An address worth looking up: a public one. A private, loopback or link-local address has no place (and a web call would only be wasted). */
export function isPublicIp(ip: string): boolean {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const kind = net.isIP(v);
  if (kind === 4) {
    const [a, b] = v.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (kind === 6) {
    const l = v.toLowerCase();
    return !(l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd'));
  }
  return false;
}

let reader: Promise<Reader<never> | null> | undefined;
let openedPath: string | undefined;

/** The database, opened once and kept in memory. A path that cannot be opened is `null` (and tried again the next time it is asked for after the path changes). */
function database(): Promise<Reader<never> | null> {
  const path = env().geoip.dbPath;
  if (!path) return Promise.resolve(null);
  if (!reader || openedPath !== path) {
    openedPath = path;
    reader = maxmind.open(path).then((r) => r as Reader<never>).catch(() => null);
  }
  return reader;
}

let client: { key: string; value: WebServiceClient } | undefined;

function webClient(): WebServiceClient | null {
  const { accountId, licenseKey } = env().geoip;
  if (!accountId || !licenseKey) return null;
  const key = `${accountId}:${licenseKey}`;
  if (client?.key !== key) client = { key, value: new WebServiceClient(accountId, licenseKey, { host: 'geolite.info', timeout: 3000 }) };
  return client.value;
}

/** The server's own sources: the local database, then the web service. */
export const realSources: GeoSources = {
  local: async (ip) => {
    try {
      const db = await database();
      return db ? placeFrom(db.get(ip) as unknown as CityLike | null) : null;
    } catch {
      return null;
    }
  },
  web: async (ip) => {
    try {
      const c = webClient();
      return c ? placeFrom((await c.city(ip)) as unknown as CityLike) : null;
    } catch {
      return null;
    }
  },
};

let override: GeoSources | undefined;
/** For tests: the sources to use instead of the real ones (`undefined` puts the real ones back). */
export function setGeoSources(next: GeoSources | undefined): void {
  override = next;
}

/** The place of an address: the local database first, the web service when it has none. `null` for a private address, or when neither knows it. */
export async function ipToGeo(ip: string, sources: GeoSources = override ?? realSources): Promise<IpPlace | null> {
  if (!isPublicIp(ip)) return null;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return (await sources.local(v)) ?? (await sources.web(v));
}

/** For tests: forget the opened database and the web client. */
export function resetGeoSources(): void {
  reader = undefined;
  openedPath = undefined;
  client = undefined;
}
