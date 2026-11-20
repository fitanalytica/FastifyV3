import type { FastifyInstance } from 'fastify';
import type { ProfileBody } from '../../types/index.js';
import { ipToGeo } from '../location/ipToGeo.js';

// docs/data/api.md section 7. The fields the user edits in Edit profile (and the new-user setup), any of them: the profile row is made on the first call, and
// every later call changes only the fields it carries (the last write wins). The new row also gets its `store_id`, the account token the app puts on its purchases
// (docs/data/api.md section 15); a row that has none is given one when the phone asks for its state. The column names below are the only ones that can reach the SQL; the values
// always go through parameters.
// A NEW profile also starts with a place from the IP address of that first request (docs/data/server.md section 7, rule 1: `geo_source = 1`); if the lookup has none, the place of the
// user's latest phone install (`downloads`: the country, city and state found when it first signed in, or the device's region). The phone's own place (PUT /profile/location) replaces it.
const FIELDS = ['fname', 'lname', 'about', 'gender', 'dobglobal', 'height', 'weight'] as const;
type Field = (typeof FIELDS)[number];
const CAST: Partial<Record<Field, string>> = { gender: '::gender_enum' };

export type SavedProfile = Pick<ProfileBody, Field>;

interface StartPlace {
  iso: string;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
}

/** Where a new user starts: the place of this request's IP address, else of their latest phone install. `null` when neither is known. */
async function startPlace(app: FastifyInstance, userid: string, ip: string | undefined): Promise<StartPlace | null> {
  const found = ip ? await ipToGeo(ip) : null;
  if (found) return found;
  const d = await app.pg.writer.query(
    `SELECT iso, city, state FROM downloads WHERE userid = $1 AND device_type = 'phone' AND iso IS NOT NULL ORDER BY ddate DESC LIMIT 1`,
    [userid],
  );
  return d.rows[0] ? { iso: d.rows[0].iso, city: d.rows[0].city, state: d.rows[0].state, lat: null, lon: null } : null;
}

/** Saves the fields and answers them as saved. A text is trimmed, and an empty one is cleared. `ip` is the request's address: a new profile starts with its place. */
export async function putProfile(app: FastifyInstance, userid: string, body: ProfileBody, ip?: string): Promise<SavedProfile> {
  const keys = FIELDS.filter((k) => body[k] !== undefined);
  const value = (k: Field) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() || null : v;
  };
  const params: unknown[] = [userid, Math.floor(Date.now() / 1000), ...keys.map(value)];
  const marks = keys.map((k, i) => `$${i + 3}${CAST[k] ?? ''}`);
  // Only a profile that is not there yet takes a starting place (an existing one keeps its own).
  const isNew = !(await app.pg.writer.query('SELECT 1 FROM userinfo WHERE userid = $1', [userid])).rowCount;
  const place = isNew ? await startPlace(app, userid, ip) : null;
  const at = params.length + 1;
  if (place) params.push(place.iso, place.city, place.state, place.lat, place.lon);
  const placeColumns = place ? ', iso, city, state, lat, lon, geom, geo_source' : '';
  const placeValues = place
    ? `, $${at}, left($${at + 1}, 50), left($${at + 2}, 50), $${at + 3}::float8, $${at + 4}::float8, CASE WHEN $${at + 3}::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($${at + 4}::float8, $${at + 3}::float8), 4326) END, 1`
    : '';
  const sql = `
    INSERT INTO userinfo (userid, dateregistered, store_id, ${keys.join(', ')}${placeColumns}) VALUES ($1, $2, gen_random_uuid(), ${marks.join(', ')}${placeValues})
    ON CONFLICT (userid) DO UPDATE SET ${keys.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
    RETURNING fname, lname, about, gender, dobglobal, height, weight`;
  const r = await app.pg.writer.query(sql, params);
  return r.rows[0];
}
