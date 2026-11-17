import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { ACTIVITY_FULL } from '../activities/columns.js';
import { authorJson } from './getFeed.js';

// docs/data/api.md section 11. The whole of one activity of someone else, for the details screen opened from a feed card: the same author and the activity exactly as
// a restore row (compact, in full, `route_preview` too). Who may read it: the owner always, anyone signed in when the owner's profile is shown. A deleted
// activity, a hidden profile (for others) and an unknown id are all 404, so nothing is revealed about which exist.

const ONE = `
  SELECT a.userid, u.fname, u.lname, u.weight, u.profilepic, u.city, u.state, u.iso, coalesce(u.hideprofile, false) AS hidden,
         (SELECT row_to_json(x)::text FROM (SELECT ${ACTIVITY_FULL}, route_preview FROM activities WHERE activityid = a.activityid) x) AS activity
    FROM activities a JOIN userinfo u ON u.userid = a.userid
   WHERE a.activityid = $1 AND a.tosend IN (1, 2)`;

/** `{ author, activity }` as JSON text, or a 404. */
export async function getPublicActivity(app: FastifyInstance, requester: string, activityid: string): Promise<string> {
  const r = await app.pg.reader.query(ONE, [activityid]);
  const row = r.rows[0];
  if (!row || (row.hidden && row.userid !== requester)) throw errors.NotFound('No such activity', ErrorCode.NOT_FOUND);
  return `{"author":${authorJson(row)},"activity":${row.activity}}`;
}
