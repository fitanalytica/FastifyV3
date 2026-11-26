import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { countryName } from '../location/countries.js';
import { ensureMailids } from './mailids.js';

// docs/data/api.md section 7. The user's userinfo row (no geom, no store id; with `mailids`, the support reference) and who they signed in with, built in SQL and returned as JSON text.
// `lat` and `lon` are the columns. Nobody has a row until the new-user setup has saved one: that is a 404, and the app reads it as "a new user".
const PROFILE = `
  SELECT json_build_object(
    'profile', json_build_object(
      'fname', i.fname, 'lname', i.lname, 'about', i.about, 'gender', i.gender, 'dobglobal', i.dobglobal, 'height', i.height, 'weight', i.weight,
      'hideprofile', i.hideprofile, 'timezone', i.timezone, 'iso', i.iso, 'city', i.city, 'state', i.state, 'lat', i.lat, 'lon', i.lon,
      'profilepic', i.profilepic, 'profilebg', i.profilebg, 'dateregistered', i.dateregistered, 'last_access_date', i.last_access_date,
      'geo_source', i.geo_source, 'mailids', i.mailids),
    'account', json_build_object('email', l.email, 'loginused', l.loginused))::text AS body
  FROM userinfo i JOIN userlogin l ON l.userid = i.userid
  WHERE i.userid = $1`;

/** The user's profile as `{ profile, account }` JSON text. 404 if there is no row yet. `profile.country` is the name of the country of `iso`,
 *  from the server's list (the database keeps only the code); it is `null` when there is no place yet or the code is not in the list. */
export async function getProfile(app: FastifyInstance, userid: string): Promise<string> {
  let r = await app.pg.reader.query(PROFILE, [userid]);
  if (!r.rowCount) r = await app.pg.writer.query(PROFILE, [userid]); // the reader can lag behind a profile just saved
  if (!r.rowCount) throw errors.NotFound('No profile yet', ErrorCode.NOT_FOUND);
  // The profile is a few hundred bytes, so reading it to add one field costs nothing (the large replies are never parsed).
  const body = JSON.parse(r.rows[0].body as string);
  body.profile.country = countryName(body.profile.iso);
  // A row from before the support reference existed is given one now (never changed after).
  if (!body.profile.mailids) body.profile.mailids = await ensureMailids(app, userid);
  return JSON.stringify(body);
}
