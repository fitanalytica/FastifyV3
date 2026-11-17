import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';

// docs/data/server.md section 4. The row stays as a marker (tosend = 0) so a late upload of the same id is answered `deleted`;
// the large columns are emptied and the small summary is kept.
// NOT DONE YET: removing the files under activitees/<activityid>/ in S3 (comes with the media slice).
const MARK_DELETED = `
  UPDATE activities SET tosend = 0,
    activitydetail_v2 = NULL, activitybpm_v2 = NULL, activitylat = NULL, activitylon = NULL, activitytimenow = NULL,
    activityelevation = NULL, activitydistance = NULL, activitydetail = NULL, activitybpm = NULL, media = NULL,
    media_details = '[]'::jsonb, media_v2 = '[]'::jsonb
  WHERE activityid = $1 AND userid = $2 AND tosend > 0
  RETURNING activityid`;

/** Deletes the user's activity. A repeat is fine (the marker answers like a fresh delete). An unknown id, or another user's, is 404:
 *  the app treats 404 as success. */
export async function deleteActivity(app: FastifyInstance, userid: string, activityid: string): Promise<void> {
  const w = app.pg.writer;
  const done = await w.query(MARK_DELETED, [activityid, userid]);
  if (done.rowCount) return;
  const marker = await w.query('SELECT 1 FROM activities WHERE activityid = $1 AND userid = $2', [activityid, userid]);
  if (!marker.rowCount) throw errors.NotFound('Unknown activity', ErrorCode.NOT_FOUND);
}
