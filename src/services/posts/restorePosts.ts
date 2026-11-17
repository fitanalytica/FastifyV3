import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';

// docs/data/api.md section 12. The user's own live posts, newest first, a page at a time (keyset cursor `<posted_at>.<postid>`), as JSON text. Read from the
// writer: the phone asks right after a restore or a share, and a post is small.

const INT4 = 2147483647;

const pageSql = (cursor: boolean) => `
  WITH page AS MATERIALIZED (
    SELECT postid, posted_at, content, media_v2 FROM posts
     WHERE userid = $1 AND tosend = 1${cursor ? ' AND (posted_at, postid) < ($3::int, $4::uuid)' : ''}
     ORDER BY posted_at DESC, postid DESC LIMIT $2)
  SELECT json_build_object(
    'posts', coalesce((SELECT json_agg(p ORDER BY p.posted_at DESC, p.postid DESC) FROM page p), '[]'::json),
    'next', (SELECT l.posted_at::text || '.' || l.postid::text
               FROM (SELECT posted_at, postid FROM page ORDER BY posted_at, postid LIMIT 1) l
              WHERE EXISTS (SELECT 1 FROM posts a WHERE a.userid = $1 AND a.tosend = 1 AND (a.posted_at, a.postid) < (l.posted_at, l.postid)))
  )::text AS body`;

export async function restorePosts(app: FastifyInstance, userid: string, o: { limit: number; before?: string }): Promise<string> {
  const args: unknown[] = [userid, o.limit];
  if (o.before) {
    const [at, id] = o.before.split('.');
    if (Number(at) > INT4) throw errors.BadRequest('bad cursor', ErrorCode.BAD_REQUEST);
    args.push(Number(at), id);
  }
  const r = await app.pg.writer.query(pageSql(Boolean(o.before)), args);
  return r.rows[0].body as string;
}
