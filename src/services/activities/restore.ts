import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { ACTIVITY_FULL } from './columns.js';

// docs/data/api.md section 4. A page is `{ activities, next, total }`, built in SQL and returned as JSON TEXT: the large arrays are never
// parsed and re-written in Node. Newest first, paged by a keyset cursor `<startdate>.<activityid>` (a page never shifts when a newer
// activity arrives, and equal start times cannot be skipped). Deleted markers (tosend = 0) are never returned.
// Read from the reader: a restore does not need the last second.

export interface PageOptions {
  limit: number;
  before?: string;
  iswatch?: boolean;
}

const INT4 = 2147483647;

function parseCursor(before: string): [number, string] {
  const [start, id] = before.split('.');
  if (Number(start) > INT4) throw errors.BadRequest('bad cursor', ErrorCode.BAD_REQUEST);
  return [Number(start), id];
}

/** Only fixed fragments are joined here, never a request value: the values go through $1..$4. */
function pageSql(cols: string, o: { cursor: boolean; watch: boolean }): string {
  const mine = (a: string) => `${a}userid = $1 AND ${a}tosend > 0${o.watch ? ` AND ${a}iswatch` : ''}`;
  return `
  WITH page AS MATERIALIZED (
    SELECT ${cols} FROM activities
     WHERE ${mine('')}${o.cursor ? ' AND (startdate, activityid) < ($3::int, $4::uuid)' : ''}
     ORDER BY startdate DESC, activityid DESC LIMIT $2)
  SELECT json_build_object(
    'activities', coalesce((SELECT json_agg(p ORDER BY p.startdate DESC, p.activityid DESC) FROM page p), '[]'::json),
    'next', (SELECT l.startdate::text || '.' || l.activityid::text
               FROM (SELECT startdate, activityid FROM page ORDER BY startdate, activityid LIMIT 1) l
              WHERE EXISTS (SELECT 1 FROM activities a WHERE ${mine('a.')} AND (a.startdate, a.activityid) < (l.startdate, l.activityid))),
    'total', ${o.cursor ? 'NULL' : `(SELECT count(*) FROM activities WHERE ${mine('')})`}
  )::text AS body`;
}

async function page(app: FastifyInstance, userid: string, cols: string, o: PageOptions): Promise<string> {
  const args: unknown[] = [userid, o.limit];
  if (o.before) args.push(...parseCursor(o.before));
  const r = await app.pg.reader.query(pageSql(cols, { cursor: Boolean(o.before), watch: Boolean(o.iswatch) }), args);
  return r.rows[0].body as string;
}

/** The user's activities in full, newest first. `total` (all the user's activities, or only the watch's with `iswatch`) is only on the first page. */
export const restoreActivities = (app: FastifyInstance, userid: string, o: PageOptions) => page(app, userid, ACTIVITY_FULL, o);
