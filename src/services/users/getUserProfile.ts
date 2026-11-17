import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { countryName } from '../location/countries.js';

// docs/data/api.md section 14. Someone's profile, for the screen opened from their name on a feed card: who they are, how many activities and photos they have,
// and the raw totals the phone makes its stats from (a row per month for the last 36, the totals, and three personal bests). The server only adds up rows it
// stores; every figure shown is worked out on the phone. Only what the feed already shows of an activity is counted (`tosend > 0`), and a profile that is hidden
// is 404 for everyone but its owner, like its activities.

const WHO = `
  SELECT userid, fname, lname, about, profilepic, profilebg, city, state, iso, dateregistered, seconds_from_gmt,
         coalesce(hideprofile, false) AS hidden, deleted_date
    FROM userinfo WHERE userid = $1`;

// A month is the user's own (their offset from GMT, as stored), not UTC.
const MONTHLY = `
  SELECT to_char(to_timestamp(startdate + $2::int) AT TIME ZONE 'UTC', 'YYYY-MM') AS ym,
         count(*)::int AS n, coalesce(sum(distance), 0)::bigint AS distance, coalesce(sum(duration), 0)::bigint AS duration
    FROM activities WHERE userid = $1 AND tosend > 0
   GROUP BY 1 ORDER BY 1 DESC LIMIT 36`;

const TOTALS = `
  SELECT count(*)::int AS n, coalesce(sum(distance), 0)::bigint AS distance, coalesce(sum(duration), 0)::bigint AS duration,
         max(distance) AS longest_distance, max(duration) AS longest_duration,
         min(duration::float8 / distance) FILTER (WHERE distance >= 1000 AND duration > 0) AS fastest_sec_per_m
    FROM activities WHERE userid = $1 AND tosend > 0`;

const PHOTOS = `
  SELECT (SELECT coalesce(sum(jsonb_array_length(media_v2)), 0) FROM activities WHERE userid = $1 AND tosend > 0 AND jsonb_typeof(media_v2) = 'array')
       + (SELECT coalesce(sum(jsonb_array_length(media_v2)), 0) FROM posts WHERE userid = $1 AND tosend = 1)  AS n`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** `{ user, counts, totals, monthly, bests }` as JSON text, or a 404. */
export async function getUserProfile(app: FastifyInstance, requester: string, userid: string): Promise<string> {
  const who = (await app.pg.reader.query(WHO, [userid])).rows[0];
  if (!who || who.deleted_date || (who.hidden && userid !== requester)) throw errors.NotFound('No such user', ErrorCode.NOT_FOUND);
  const gmt = who.seconds_from_gmt ?? 0;
  const [monthly, totals, photos] = await Promise.all([
    app.pg.reader.query(MONTHLY, [userid, gmt]),
    app.pg.reader.query(TOTALS, [userid]),
    app.pg.reader.query(PHOTOS, [userid]),
  ]);
  const t = totals.rows[0];
  return JSON.stringify({
    user: {
      userid: who.userid, fname: who.fname, lname: who.lname, about: who.about, profilepic: who.profilepic, profilebg: who.profilebg,
      city: who.city, state: who.state, iso: who.iso, country: countryName(who.iso), dateregistered: who.dateregistered,
    },
    counts: { activities: t.n, photos: Number(photos.rows[0].n) },
    totals: { distance: Number(t.distance), duration: Number(t.duration) },
    monthly: monthly.rows.map((r) => ({ ym: r.ym, n: r.n, distance: Number(r.distance), duration: Number(r.duration) })),
    bests: {
      longest_distance: num(t.longest_distance),
      longest_duration: num(t.longest_duration),
      fastest_sec_per_km: t.fastest_sec_per_m === null ? null : Math.round(Number(t.fastest_sec_per_m) * 1000),
    },
  });
}
