import type { FastifyInstance } from 'fastify';
import { countries, isCountryCode } from '../location/countries.js';
import { ipToGeo } from '../location/ipToGeo.js';
import type { DeviceInfo } from '../../types/index.js';

/** The `downloads.platform` of a device: a watch is watchos (Apple) or wearos (Android). */
const platformFor = (android: boolean, watch: boolean) => (watch ? (android ? 'wearos' : 'watchos') : android ? 'android' : 'ios');

// The text of a column, cut to its length (a longer one is cut, never refused); empty is nothing.
const cut = (v: string | null | undefined, max: number) => v?.trim().slice(0, max) || null;

/** What the phone said, as the `downloads` columns (each cut to its length). */
function deviceColumns(i: DeviceInfo | undefined) {
  return [cut(i?.os, 10), cut(i?.appVersion, 10), cut(i?.code, 100), cut(i?.manufacturer, 100), cut(i?.model, 100), cut(i?.timezone, 100), cut(i?.fcmToken, 4096)] as const;
}

/** The place of an install: what is in its row, with the country's name from the server's list, and the coordinates when this very request looked them up. */
export interface InstallPlace {
  iso: string;
  city: string | null;
  state: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
}

interface Found {
  iso: string;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
}

/**
 * The first-download place of an install (docs/data/server.md section 7, rule 1): the country, city and state of the request's IP address, from the local database (the web service
 * when it has none). A failed lookup is not an error: the device's own region (`region`) is the first guess for the country. Nothing when there is neither.
 */
export async function firstDownloadPlace(ip: string | undefined, region: string | undefined): Promise<Found | null> {
  const place = ip ? await ipToGeo(ip) : null;
  if (place) return { iso: place.iso, city: place.city?.slice(0, 50) ?? null, state: place.state?.slice(0, 50) ?? null, lat: place.lat, lon: place.lon };
  const guess = region?.toUpperCase();
  return guess && isCountryCode(guess) ? { iso: guess, city: null, state: null, lat: null, lon: null } : null;
}

const NOW = `EXTRACT(EPOCH FROM now())::int`;
const KEEP = (column: string) => `${column} = COALESCE(EXCLUDED.${column}, downloads.${column})`;

/**
 * Makes the install's `downloads` row, or brings it up to date: the phone's (or the watch's) download id and device id, what it said about itself (docs/data/schema.pg.md section 4), and the
 * place of its IP address. **It is made when the app is first opened, signed in or not** (`userid` is empty until someone signs in), and again at sign-in, which **sets the owner**; a repeat with
 * no owner never clears one. A repeat changes `last_access_date` and the device fields it carries (a field it does not carry keeps what it had). The place (`iso`, `city`, `state`) is looked up only
 * while the row has none, and never changed after: the user's place is `userinfo`'s. A watch is the same, with its own row. Answers the place the row has (`null` when there is none).
 */
export async function registerDownload(
  app: FastifyInstance,
  d: { downloadid: string; userid?: string | null; deviceid?: string; platform?: string; watch?: boolean; info?: DeviceInfo; ip?: string },
): Promise<InstallPlace | null> {
  const w = app.pg.writer;
  const known = await w.query('SELECT iso FROM downloads WHERE downloadid = $1', [d.downloadid]);
  const found = known.rows[0]?.iso ? null : await firstDownloadPlace(d.ip, d.info?.region);
  const r = await w.query(
    `INSERT INTO downloads (downloadid, userid, deviceid, device_type, platform, device_os, appversion, device_code, device_manufacturer, device_model, timezone, fcm_token, iso, city, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (downloadid) DO UPDATE SET userid = COALESCE(EXCLUDED.userid, downloads.userid), deviceid = COALESCE(EXCLUDED.deviceid, downloads.deviceid), last_access_date = ${NOW},
       ${['device_os', 'appversion', 'device_code', 'device_manufacturer', 'device_model', 'timezone', 'fcm_token'].map(KEEP).join(', ')},
       iso = COALESCE(downloads.iso, EXCLUDED.iso), city = COALESCE(downloads.city, EXCLUDED.city), state = COALESCE(downloads.state, EXCLUDED.state)
     RETURNING iso, city, state`,
    [
      d.downloadid, d.userid ?? null, d.deviceid ?? null, d.watch ? 'watch' : 'phone', platformFor(d.platform === 'android', Boolean(d.watch)), ...deviceColumns(d.info),
      found?.iso ?? null, found?.city ?? null, found?.state ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row?.iso) return null;
  const fresh = found && found.iso === row.iso;
  return { iso: row.iso, city: row.city, state: row.state, country: countries[row.iso as keyof typeof countries] ?? null, lat: fresh ? found.lat : null, lon: fresh ? found.lon : null };
}

/**
 * The phone tells the server what changed about it (the `device` section of the sync call): the device fields it carries, and `last_access_date`. `fcmToken: null` takes the push token away (notifications were turned off). Only the user's own install is changed. If that install has no place
 * yet (the first lookup failed), it is tried again now. A watch's row is not changed here.
 */
export async function updateDevice(app: FastifyInstance, userid: string, downloadid: string, info: DeviceInfo, ip: string | undefined): Promise<void> {
  const w = app.pg.writer;
  const own = await w.query(`SELECT iso, device_type::text AS device_type FROM downloads WHERE downloadid = $1 AND userid = $2`, [downloadid, userid]);
  const row = own.rows[0];
  if (!row || row.device_type === 'watch') return;
  const place = row.iso ? null : await firstDownloadPlace(ip, info.region);
  await w.query(
    `UPDATE downloads SET last_access_date = ${NOW},
       device_os = COALESCE($3, device_os), appversion = COALESCE($4, appversion), device_code = COALESCE($5, device_code), device_manufacturer = COALESCE($6, device_manufacturer),
       device_model = COALESCE($7, device_model), timezone = COALESCE($8, timezone), fcm_token = CASE WHEN $13::boolean THEN NULL ELSE COALESCE($9, fcm_token) END,
       iso = COALESCE(iso, $10), city = COALESCE(city, $11), state = COALESCE(state, $12)
     WHERE downloadid = $1 AND userid = $2`,
    [downloadid, userid, ...deviceColumns(info), place?.iso ?? null, place?.city ?? null, place?.state ?? null, info.fcmToken === null],
  );
}
