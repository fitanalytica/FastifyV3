import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { ProfileCommitBody, ProfilePresignBody } from '../../types/index.js';
import { MEDIA_URL_SECONDS } from './mediaUrl.js';
import { PROFILE_COLUMN, PROFILE_EXTENSION, PROFILE_MAX_BYTES, UPLOAD_URL_SECONDS, type ProfileImageKind } from './limits.js';
import { deleteObjects, headObject } from './s3Ops.js';
import { s3 } from './s3Client.js';
import type { Presigned } from './presign.js';

// docs/data/api.md section 7b. The profile picture and the cover: one file each, in the `fitpy` bucket under `<uuid>.<ext>`, the name kept in
// `userinfo.profilepic` / `profilebg`. Same shape as the activity media: presign, PUT, commit; and a reset. A new image replaces the old one (its file is
// deleted after the row changes: a failed S3 delete leaves an orphan, never a broken profile). The column names come from PROFILE_COLUMN, a fixed table,
// never from the request, so they are safe to put in the SQL.

/**
 * What the column holds is a file name in our bucket, EXCEPT for users of the old app, whose `profilepic` is the sign-in provider's `https` address. That is
 * left as it is (the phone shows initials until a picture is chosen) and is never a key: it is not deleted from S3 (docs/data/production-checklist.md).
 */
export const isOurFile = (value: string | null | undefined): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);

const HAS_PROFILE = 'SELECT 1 FROM userinfo WHERE userid = $1';

async function requireProfile(app: FastifyInstance, userid: string): Promise<void> {
  if (!(await app.pg.writer.query(HAS_PROFILE, [userid])).rowCount) throw errors.NotFound('No profile yet', ErrorCode.NOT_FOUND);
}

export async function presignProfileImage(app: FastifyInstance, userid: string, body: ProfilePresignBody): Promise<Presigned> {
  const ext = PROFILE_EXTENSION[body.contentType];
  if (!ext) throw errors.BadRequest(`${body.contentType} is not allowed`, ErrorCode.BAD_MEDIA);
  if (body.bytes > PROFILE_MAX_BYTES[body.kind]) throw errors.BadRequest(`A ${body.kind} may be at most ${PROFILE_MAX_BYTES[body.kind]} bytes`, ErrorCode.BAD_MEDIA);
  await requireProfile(app, userid);
  const value = `${randomUUID()}.${ext}`;
  const command = new PutObjectCommand({ Bucket: env().s3.bucketProfile, Key: value, ContentType: body.contentType, ContentLength: body.bytes });
  const url = await getSignedUrl(s3(), command, { expiresIn: UPLOAD_URL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) });
  return { value, url, headers: { 'Content-Type': body.contentType } };
}

/** Sets the column to the new file and returns the name it had. `prev` is read in the same statement, under the row's lock. */
const setSql = (column: string) => `
  UPDATE userinfo u SET ${column} = $2
    FROM (SELECT userid, ${column} AS prev FROM userinfo WHERE userid = $1 FOR UPDATE) o
   WHERE u.userid = o.userid RETURNING o.prev AS prev`;

export async function commitProfileImage(app: FastifyInstance, userid: string, body: ProfileCommitBody): Promise<string> {
  await requireProfile(app, userid);
  const head = await headObject(body.value, 'profile');
  const ext = body.value.slice(body.value.lastIndexOf('.') + 1);
  if (!head) throw errors.BadRequest(`${body.value} was not uploaded`, ErrorCode.BAD_MEDIA);
  if (head.size > PROFILE_MAX_BYTES[body.kind] || (head.contentType && head.contentType !== (ext === 'jpg' ? 'image/jpeg' : 'image/webp'))) {
    await deleteObjects([body.value], 'profile').catch(() => {});
    throw errors.BadRequest(`${body.value} has the wrong size or type`, ErrorCode.BAD_MEDIA);
  }
  const r = await app.pg.writer.query(setSql(PROFILE_COLUMN[body.kind]), [userid, body.value]);
  const prev = r.rows[0]?.prev as string | null | undefined;
  if (isOurFile(prev) && prev !== body.value) {
    await deleteObjects([prev], 'profile').catch((e) => app.log.error({ err: e, userid }, 'old profile image not deleted from S3 (orphan)'));
  }
  return body.value;
}

/** Back to no image. Idempotent: no image set is still 204. */
export async function resetProfileImage(app: FastifyInstance, userid: string, kind: ProfileImageKind): Promise<void> {
  await requireProfile(app, userid);
  const r = await app.pg.writer.query(setSql(PROFILE_COLUMN[kind]), [userid, null]);
  const prev = r.rows[0]?.prev as string | null | undefined;
  if (isOurFile(prev)) await deleteObjects([prev], 'profile').catch((e) => app.log.error({ err: e, userid }, 'old profile image not deleted from S3 (orphan)'));
}

/**
 * The pre-signed GET address of a user's current picture or cover, for `requester`. `value` must be what the user has set now, so the route cannot be
 * used to read any other file in the bucket. The owner always; others only when the profile is shown (404 otherwise, so nothing is revealed).
 */
export async function getProfileImageUrl(app: FastifyInstance, requester: string, owner: string, kind: ProfileImageKind, value: string): Promise<string> {
  const column = PROFILE_COLUMN[kind];
  const sql = `SELECT ${column} AS current, coalesce(hideprofile, false) AS hidden FROM userinfo WHERE userid = $1`;
  let r = await app.pg.reader.query(sql, [owner]);
  if (!r.rowCount || r.rows[0].current !== value) r = await app.pg.writer.query(sql, [owner]); // the reader can lag behind a change just made
  const row = r.rows[0] as { current: string | null; hidden: boolean } | undefined;
  if (!row || row.current !== value || (row.hidden && owner !== requester)) throw errors.NotFound('No such image', ErrorCode.NOT_FOUND);
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env().s3.bucketProfile, Key: value }), { expiresIn: MEDIA_URL_SECONDS });
}
