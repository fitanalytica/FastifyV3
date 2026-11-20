import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { ipToGeo, type GeoSources } from './ipToGeo.js';
import { checkIpref, makeIpref } from './ipref.js';

// docs/data/server.md section 7, rule 4: while the phone's location is off (`X-Location: off`) the IP address is the source of the user's place (`geo_source = 1`), even if the last place
// came from the GPS. It is looked up only when the address changed and the last lookup is a day old (or there is none): `ipref`.
// The place is changed only if it really is different, so a lookup that finds the same place writes nothing.
const SQL = `
  UPDATE userinfo
     SET lat = $2::float8, lon = $3::float8, city = left($4, 50), state = left($5, 50), iso = $6,
         geom = CASE WHEN $2::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326) END, geo_source = 1
   WHERE userid = $1
     AND (city, state, iso) IS DISTINCT FROM (left($4, 50), left($5, 50), $6)`;

/**
 * For a request from a phone that says its location is off: compares the address with the `ipref` it sent, looks the place up when the address changed (and the last lookup is a day old
 * or missing), and saves it. Answers the `ipref` the phone should keep: a new one after a lookup, else the one it sent. A failed lookup never blocks anything: the place stays as it was, and
 * the new `ipref` still goes out (the lookup is tried again after a day, or if the address changes by then). Never throws.
 */
export async function applyIpLocation(app: FastifyInstance, userid: string, ip: string, ipref: string | undefined, now: number = Math.floor(Date.now() / 1000), sources?: GeoSources): Promise<string | undefined> {
  const key = env().iprefKey;
  try {
    const change = checkIpref(ip, ipref, now, key);
    if (change !== 'changed') return ipref;
    const place = await ipToGeo(ip, sources);
    if (place) {
      await app.pg.writer.query(SQL, [userid, place.lat, place.lon, place.city, place.state, place.iso]);
    }
    return makeIpref(ip, now, key);
  } catch (e) {
    app.log.warn({ err: e }, 'IP location failed');
    return ipref;
  }
}
