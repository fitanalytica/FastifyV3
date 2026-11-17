import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { PostContent, PutPostBody } from '../../types/index.js';

// docs/data/api.md section 12. A post is made on the phone with an id of its own, so a repeat of the same PUT (the answer was lost) changes nothing but what
// it says. The photos and videos come after, through the media routes (the post id is used like an activity id there).

const TEMPLATE_NEEDS: Record<NonNullable<PostContent['template']>, (keyof PostContent)[]> = {
  steps: ['steps'],
  distance: ['distance'],
  steps_distance: ['steps', 'distance'],
};

/** The rules the schema cannot say: a template carries the numbers it shows, and a post has something to show (media coming, a title or a description). */
export function checkPost(body: PutPostBody): void {
  const { content } = body;
  for (const key of content.template ? TEMPLATE_NEEDS[content.template] : []) {
    if (content[key] === undefined) throw errors.BadRequest(`The ${content.template} template needs ${key}`, ErrorCode.BAD_POST);
  }
  const text = Boolean(content.title?.trim() || content.description?.trim());
  if (!text && !(body.media && body.media > 0)) throw errors.BadRequest('A post needs photos or videos, a title or a description', ErrorCode.BAD_POST);
}

const UPSERT = `
  INSERT INTO posts (postid, userid, posted_at, content) VALUES ($1, $2, $3, $4::jsonb)
  ON CONFLICT (postid) DO UPDATE SET content = CASE WHEN posts.tosend > 0 THEN EXCLUDED.content ELSE posts.content END
   WHERE posts.userid = $2
  RETURNING tosend, media_v2, (xmax = 0) AS inserted`;

export type PutPostResult = { status: 'created' | 'exists' | 'deleted'; media_v2: unknown[] };

/** Makes the post or changes what it says (its time and its media are not changed here). A deleted post answers `deleted`; an id that is another user's is 404. */
export async function putPost(app: FastifyInstance, userid: string, postid: string, body: PutPostBody): Promise<PutPostResult> {
  checkPost(body);
  const r = await app.pg.writer.query(UPSERT, [postid, userid, body.posted_at, JSON.stringify(body.content)]);
  const row = r.rows[0] as { tosend: number; media_v2: unknown[]; inserted: boolean } | undefined;
  if (!row) throw errors.NotFound('No such post', ErrorCode.NOT_FOUND);
  return { status: row.tosend === 0 ? 'deleted' : row.inserted ? 'created' : 'exists', media_v2: row.media_v2 };
}
