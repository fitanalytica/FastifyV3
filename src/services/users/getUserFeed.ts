import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { FEED_ACTIVITY } from '../activities/columns.js';
import { authorJson } from '../feed/getFeed.js';

// docs/data/api.md section 14. One user's activities and posts in the SAME shape and order as the feed (newest first by end time, keyset cursor `<time>.<id>`),
// so the phone reads it with the code that reads the feed. `kind` keeps one of the two, `media` keeps only items with photos or videos (the Photos tab). A hidden
// profile is 404 for everyone but its owner.

export interface UserFeedOptions {
  limit: number;
  before?: string;
  kind?: 'activity' | 'post';
  media?: boolean;
}

const INT4 = 2147483647;

function parseCursor(before: string): [number, string] {
  const end = Number(before.slice(0, before.indexOf('.')));
  if (!Number.isInteger(end) || Math.abs(end) > INT4) throw errors.BadRequest('bad cursor', ErrorCode.BAD_REQUEST);
  return [end, before.slice(before.indexOf('.') + 1)];
}

// Only fixed fragments are joined here, never a request value: the values go through $1..$4.
function sql(o: UserFeedOptions): string {
  const cursor = (col: string, id: string) => (o.before ? `AND (${col}, ${id}) < ($3::int, $4::uuid)` : '');
  const sides: string[] = [];
  if (o.kind !== 'post') {
    sides.push(`(SELECT 'activity'::text AS kind, a.activityid AS id, a.enddate AS at FROM activities a
        WHERE a.userid = $1 AND a.tosend IN (1, 2) ${o.media ? `AND a.media_v2 <> '[]'::jsonb` : ''} ${cursor('a.enddate', 'a.activityid')}
        ORDER BY a.enddate DESC, a.activityid DESC LIMIT $2)`);
  }
  if (o.kind !== 'activity') {
    sides.push(`(SELECT 'post'::text AS kind, p.postid AS id, p.posted_at AS at FROM posts p
        WHERE p.userid = $1 AND p.tosend = 1
          AND ${o.media ? `p.media_v2 <> '[]'::jsonb` : `(p.media_v2 <> '[]'::jsonb OR btrim(coalesce(p.content->>'title', '')) <> '' OR btrim(coalesce(p.content->>'description', '')) <> '')`}
          ${cursor('p.posted_at', 'p.postid')}
        ORDER BY p.posted_at DESC, p.postid DESC LIMIT $2)`);
  }
  return `
  WITH latest AS (
    SELECT * FROM (${sides.join(' UNION ALL ')}) both_kinds ORDER BY at DESC, id DESC LIMIT $2)
  SELECT l.kind, l.id, l.at, u.userid, u.fname, u.lname, u.weight, u.profilepic, u.city, u.state, u.iso,
         CASE l.kind
           WHEN 'activity' THEN (SELECT row_to_json(x)::text FROM (SELECT ${FEED_ACTIVITY} FROM activities WHERE activityid = l.id) x)
           ELSE (SELECT row_to_json(x)::text FROM (SELECT postid, posted_at, content, media_v2 FROM posts WHERE postid = l.id) x)
         END AS item
    FROM latest l CROSS JOIN userinfo u WHERE u.userid = $1
   ORDER BY l.at DESC, l.id DESC`;
}

/** `{ posts: [{ kind, author, activity | post }], next }` as JSON text (the feed's shape), or a 404 for an unknown or hidden user. */
export async function getUserFeed(app: FastifyInstance, requester: string, userid: string, o: UserFeedOptions): Promise<string> {
  const who = (await app.pg.reader.query('SELECT coalesce(hideprofile, false) AS hidden, deleted_date FROM userinfo WHERE userid = $1', [userid])).rows[0];
  if (!who || who.deleted_date || (who.hidden && userid !== requester)) throw errors.NotFound('No such user', ErrorCode.NOT_FOUND);
  const args: unknown[] = [userid, o.limit + 1];
  if (o.before) args.push(...parseCursor(o.before));
  const r = await app.pg.reader.query(sql(o), args);
  const page = r.rows.slice(0, o.limit);
  const last = page[page.length - 1];
  const next = r.rows.length > o.limit && last ? `${last.at}.${last.id}` : null;
  const posts = page.map((row) => `{"kind":"${row.kind}","author":${authorJson(row)},"${row.kind}":${row.item}}`);
  return `{"posts":[${posts.join(',')}],"next":${JSON.stringify(next)}}`;
}
