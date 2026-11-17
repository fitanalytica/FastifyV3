import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { deleteFolder } from '../media/s3Ops.js';

// docs/data/api.md section 12. The row stays as a marker (tosend = 0) so a late PUT of the same id is answered `deleted`; what it said and its media list are
// emptied, and every file under <postid>/ in S3 goes. A failed S3 delete leaves orphans for a clean-up job and never fails the delete.
const MARK_DELETED = `
  UPDATE posts SET tosend = 0, content = '{}'::jsonb, media_v2 = '[]'::jsonb
   WHERE postid = $1 AND userid = $2 AND tosend > 0
  RETURNING postid`;

/** Deletes the user's post. A repeat is fine; an unknown id, or another user's, is 404 (the app treats 404 as success). */
export async function deletePost(app: FastifyInstance, userid: string, postid: string): Promise<void> {
  const w = app.pg.writer;
  const done = await w.query(MARK_DELETED, [postid, userid]);
  if (!done.rowCount) {
    const marker = await w.query('SELECT 1 FROM posts WHERE postid = $1 AND userid = $2', [postid, userid]);
    if (!marker.rowCount) throw errors.NotFound('Unknown post', ErrorCode.NOT_FOUND);
  }
  await deleteFolder(postid).catch((e) => app.log.error({ err: e, postid }, 'post files not deleted from S3 (orphans)'));
}
