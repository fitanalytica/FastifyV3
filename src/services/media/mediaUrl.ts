import type { FastifyInstance } from 'fastify';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { s3 } from './s3Client.js';

// docs/data/api.md section 6. A file of an activity is read through a short-lived pre-signed S3 address, so the bytes never go through Node and the
// bucket stays private. Who may read it: the owner always; anyone signed in if the owner's profile is shown. A deleted activity, a hidden
// profile (for others) and an unknown activity all answer 404, so nothing is revealed about which exist.

/** How long the address works. The phone asks again for the same path, so it never has to keep one. */
export const MEDIA_URL_SECONDS = 900;

// An activity's or a post's: the id is in one of the two tables (owner.ts).
const OWNER = `
  SELECT o.userid, coalesce(u.hideprofile, false) AS hidden
    FROM (SELECT userid FROM activities WHERE activityid = $1 AND tosend > 0
          UNION ALL
          SELECT userid FROM posts WHERE postid = $1 AND tosend > 0) o
    LEFT JOIN userinfo u ON u.userid = o.userid`;

/** The pre-signed GET address of `<activityid>/<value>` for `requester`, or a 404. The file itself is not checked: a missing one is S3's 404. */
export async function getMediaUrl(app: FastifyInstance, requester: string, activityid: string, value: string): Promise<string> {
  let r = await app.pg.reader.query(OWNER, [activityid]);
  if (!r.rowCount) r = await app.pg.writer.query(OWNER, [activityid]); // the reader can lag behind an activity just uploaded
  const row = r.rows[0] as { userid: string; hidden: boolean } | undefined;
  if (!row || (row.hidden && row.userid !== requester)) throw errors.NotFound('No such media', ErrorCode.NOT_FOUND);
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env().s3.bucketMedia, Key: `${activityid}/${value}` }), { expiresIn: MEDIA_URL_SECONDS });
}
