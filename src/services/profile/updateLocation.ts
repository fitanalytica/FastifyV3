import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { LocationBody, LocationResponse } from '../../types/index.js';
import { countries, isCountryCode } from '../location/countries.js';

// docs/data/server.md section 7, the phone's location (`X-Location: on`): exact coordinates, the source is GPS (geo_source = 2).
// `lat` and `lon` are REAL columns (about 7 digits), so the exact point is in `geom`, which holds doubles (longitude first).
const SQL = `
  UPDATE userinfo
     SET lat = $2::float8, lon = $3::float8, city = left($4, 50), state = left($5, 50), iso = $6,
         geom = ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326), geo_source = 2
   WHERE userid = $1`;

/**
 * Saves where the phone is. The country code is checked against the server's list (`countries`) and stored upper case; the country's name is
 * never stored, it is looked up from the code. (0, 0) is refused: it is what a failed fix looks like, and the location stays unknown, not
 * wrong. A user with no profile row yet (the new-user setup has not been saved) gets a 404, and the phone tries again after it has.
 */
export async function updateLocation(app: FastifyInstance, userid: string, body: LocationBody): Promise<LocationResponse> {
  const iso = body.iso.trim().toUpperCase();
  if (!isCountryCode(iso)) {
    throw errors.BadRequest('iso is not a country code', ErrorCode.BAD_REQUEST);
  }
  const city = body.city.trim();
  if (!city) {
    throw errors.BadRequest('city is empty', ErrorCode.BAD_REQUEST);
  }
  if (body.lat === 0 && body.lon === 0) {
    throw errors.BadRequest('(0, 0) is not a location', ErrorCode.BAD_REQUEST);
  }
  const state = body.state?.trim() || null;
  const r = await app.pg.writer.query(SQL, [userid, body.lat, body.lon, city, state, iso]);
  if (!r.rowCount) {
    throw errors.NotFound('No profile yet', ErrorCode.NOT_FOUND);
  }
  return { lat: body.lat, lon: body.lon, city: city.slice(0, 50), state: state ? state.slice(0, 50) : null, iso, country: countries[iso] };
}
