import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isFeedScrubUp, type SectionResult, type SyncContext } from '../../types/index.js';

// The `feedScrub` section is a read (docs/data/sync.md section 4e). The phone sends the ids of everything in its feed cache; the answer is `down.feedScrub = { gone }`: the ids the feed would no longer show this
// user (an activity or post that was deleted, is not shared (`tosend`), or whose owner hides their profile), so the phone removes them (and any video it saved). The rule is the feed's own (getFeed.ts): one
// place for what the feed shows, the same here. Your own items are not special: a hidden profile leaves the feed for you too (your own posts are read from your phone's database, not from this cache).
export const applyFeedScrub = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isFeedScrubUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

// Which of the given ids the feed still shows: an activity (`tosend` 1 or 2) or a post (`tosend` 1, with something to show), of a user who shows their profile.
const VISIBLE = `
  SELECT a.activityid::text AS id FROM activities a JOIN userinfo u ON u.userid = a.userid
   WHERE a.activityid = ANY($1::uuid[]) AND a.tosend IN (1, 2) AND u.hideprofile = false
  UNION ALL
  SELECT p.postid::text FROM posts p JOIN userinfo u ON u.userid = p.userid
   WHERE p.postid = ANY($1::uuid[]) AND p.tosend = 1 AND u.hideprofile = false
     AND (p.media_v2 <> '[]'::jsonb OR btrim(coalesce(p.content->>'title', '')) <> '' OR btrim(coalesce(p.content->>'description', '')) <> '')`;

async function visibleOf(app: FastifyInstance, ids: string[], writer: boolean): Promise<Set<string>> {
  if (!ids.length) {
    return new Set();
  }
  const r = await (writer ? app.pg.writer : app.pg.reader).query<{ id: string }>(VISIBLE, [ids]);
  return new Set(r.rows.map(row => row.id));
}

export async function readFeedScrub(app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  if (!isFeedScrubUp(up)) {
    return undefined;
  }
  const ids = [...new Set(up.ids.map(id => id.toLowerCase()))];
  const shown = await visibleOf(app, ids, false);
  let gone = ids.filter(id => !shown.has(id));
  if (gone.length) {
    // The reader can lag behind something just uploaded: what it does not show is asked again on the writer before anything is called gone.
    const again = await visibleOf(app, gone, true);
    gone = gone.filter(id => !again.has(id));
  }
  return { down: { gone } };
}
