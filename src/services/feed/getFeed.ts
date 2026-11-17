import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { FEED_ACTIVITY } from '../activities/columns.js';
import { countryName } from '../location/countries.js';

// docs/data/api.md section 11. The feed: the most recent activities AND posts (section 12) of users who show their profile, newest first by END TIME (`enddate`, an index
// `activities_feed` serves it, so the table is not scanned), a page at a time (20 by default) with a keyset cursor `<time>.<id>`, so a page never
// shifts when something new arrives. It is the old app's feed query without its "only a user's latest activity" rule, and without its ordering by the
// user's offset from GMT (a stored offset that moves with the user, which no index can serve; real time is the order people expect).
// TODO (production): a limit per user, so one busy user cannot fill the feed.
// A post carries the SMALL part of the activity (FEED_ACTIVITY: the summary and `route_preview`), not the track: a card draws the preview, and the full
// activity is read when the user opens it (getPublicActivity). The activity is read as JSON TEXT and joined into the reply by string. The author is a few small
// fields, read as columns, so the country's name can be added from the server's list.

export interface FeedOptions {
  limit: number;
  before?: string;
}

const INT4 = 2147483647;

function parseCursor(before: string): [number, string] {
  const at = before.indexOf('.');
  const end = Number(before.slice(0, at));
  if (!Number.isInteger(end) || Math.abs(end) > INT4) throw errors.BadRequest('bad cursor', ErrorCode.BAD_REQUEST);
  return [end, before.slice(at + 1)];
}

/**
 * Activities and posts in one list, newest first. Each side is read newest first with its own index and cut to a page, then the two are merged and cut again:
 * so nothing is scanned. A post with nothing to show (no media yet, no text: the phone has made it but not uploaded its files) is not in the feed.
 * Only fixed fragments are joined here, never a request value: the values go through $1..$3. One row more than the page is read, to know if there is a next.
 */
const feedSql = (cursor: boolean) => `
  WITH latest AS (
    SELECT * FROM (
      (SELECT 'activity'::text AS kind, a.activityid AS id, a.userid, a.enddate AS at
         FROM activities a JOIN userinfo u ON u.userid = a.userid
        WHERE a.tosend IN (1, 2) AND u.hideprofile = false${cursor ? '\n          AND (a.enddate, a.activityid) < ($2::int, $3::uuid)' : ''}
        ORDER BY a.enddate DESC, a.activityid DESC LIMIT $1)
      UNION ALL
      (SELECT 'post'::text, p.postid, p.userid, p.posted_at
         FROM posts p JOIN userinfo u ON u.userid = p.userid
        WHERE p.tosend = 1 AND u.hideprofile = false
          AND (p.media_v2 <> '[]'::jsonb OR btrim(coalesce(p.content->>'title', '')) <> '' OR btrim(coalesce(p.content->>'description', '')) <> '')${cursor ? '\n          AND (p.posted_at, p.postid) < ($2::int, $3::uuid)' : ''}
        ORDER BY p.posted_at DESC, p.postid DESC LIMIT $1)
    ) both_kinds
    ORDER BY at DESC, id DESC
    LIMIT $1)
  SELECT l.kind, l.id, l.at, l.userid, u.fname, u.lname, u.weight, u.profilepic, u.city, u.state, u.iso,
         CASE l.kind
           WHEN 'activity' THEN (SELECT row_to_json(x)::text FROM (SELECT ${FEED_ACTIVITY} FROM activities WHERE activityid = l.id) x)
           ELSE (SELECT row_to_json(x)::text FROM (SELECT postid, posted_at, content, media_v2 FROM posts WHERE postid = l.id) x)
         END AS item
    FROM latest l JOIN userinfo u ON u.userid = l.userid
   ORDER BY l.at DESC, l.id DESC`;

interface FeedRow {
  kind: 'activity' | 'post'; id: string; at: number; userid: string; fname: string | null; lname: string | null; weight: number | null;
  profilepic: string | null; city: string | null; state: string | null; iso: string | null; item: string;
}

/** The author of a post, as JSON text: a few small fields, with the country's name from the server's list. */
export function authorJson(row: Pick<FeedRow, 'userid' | 'fname' | 'lname' | 'weight' | 'profilepic' | 'city' | 'state' | 'iso'>): string {
  return JSON.stringify({
    userid: row.userid, fname: row.fname, lname: row.lname, weight: row.weight, profilepic: row.profilepic,
    city: row.city, state: row.state, iso: row.iso, country: countryName(row.iso),
  });
}

/** `{ posts: [{ kind, author, activity | post }], next }` as JSON text, newest first (`kind` is `activity` or `post`). `next` is the cursor for the page after this one, or null at the end.
 *  The author's `country` is the name of the country of their `iso`, from the server's list. */
export async function getFeed(app: FastifyInstance, o: FeedOptions): Promise<string> {
  const args: unknown[] = [o.limit + 1];
  if (o.before) args.push(...parseCursor(o.before));
  const r = await app.pg.reader.query<FeedRow>(feedSql(Boolean(o.before)), args);
  const page = r.rows.slice(0, o.limit);
  const last = page[page.length - 1];
  const next = r.rows.length > o.limit && last ? `${last.at}.${last.id}` : null;
  const posts = page.map((row) => `{"kind":"${row.kind}","author":${authorJson(row)},"${row.kind}":${row.item}}`);
  return `{"posts":[${posts.join(',')}],"next":${JSON.stringify(next)}}`;
}

/** A weak ETag of a reply: the same page of the feed gives the same tag, so a phone that has it is answered 304 with no body (docs/data/api.md section 11). */
export const etagOf = (body: string): string => `W/"${createHash('sha1').update(body).digest('base64url')}"`;
