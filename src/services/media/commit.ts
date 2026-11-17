import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { CommitBody } from '../../types/index.js';
import { EXTENSION, MAX_BYTES, MAX_MEDIA_PER_ACTIVITY, type Role } from './limits.js';
import { OWNER_TABLE, ownerKind } from './owner.js';
import { deleteObjects, headObject } from './s3Ops.js';

// docs/data/api.md section 6, step 3. The file is in S3: check that it is really there with the size and type that were allowed, then add the item
// to the activity's list in one statement. The item is `{ type, value, dimension, duration?, poster?, blur? }` (`blur`: the phone's placeholder, stored as it is); the file name is the server's own
// (`<uuid>.<ext>`). A repeat of the same commit (the answer was lost) changes nothing and answers the same list.

/** Only the table and its id column differ between an activity and a post (owner.ts); they are fixed words, never a request value. */
const appendSql = (table: string, id: string) => `
  UPDATE ${table} SET media_v2 = CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(media_v2, '[]'::jsonb)) e WHERE e->>'value' = $3) THEN coalesce(media_v2, '[]'::jsonb)
      ELSE coalesce(media_v2, '[]'::jsonb) || $4::jsonb END
  WHERE ${id} = $1 AND userid = $2 AND tosend > 0
    AND (jsonb_array_length(coalesce(media_v2, '[]'::jsonb)) < $5
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(media_v2, '[]'::jsonb)) e WHERE e->>'value' = $3))
  RETURNING media_v2`;

const MIME_OF: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', mp4: 'video/mp4' };

async function checkFile(activityid: string, value: string, role: Role): Promise<void> {
  const ext = value.slice(value.lastIndexOf('.') + 1);
  if (!Object.values(EXTENSION[role]).includes(ext)) throw errors.BadRequest(`${value} is not a ${role}`, ErrorCode.BAD_MEDIA);
  const head = await headObject(`${activityid}/${value}`);
  if (!head) throw errors.BadRequest(`${value} was not uploaded`, ErrorCode.BAD_MEDIA);
  if (head.size > MAX_BYTES[role]) throw errors.BadRequest(`${value} is too large`, ErrorCode.BAD_MEDIA);
  if (head.contentType && head.contentType !== MIME_OF[ext]) throw errors.BadRequest(`${value} has the wrong content type`, ErrorCode.BAD_MEDIA);
}

/** Adds the uploaded file to the activity (or post). Returns its whole `media_v2` list after the change. */
export async function commitMedia(app: FastifyInstance, userid: string, activityid: string, body: CommitBody): Promise<unknown[]> {
  const kind = await ownerKind(app, userid, activityid);
  if (!kind) {
    // Nothing is deleted here: the owner may have the file, and a stranger cannot name it.
    throw errors.NotFound('No such activity', ErrorCode.NOT_FOUND);
  }
  const uploaded = [body.value, ...(body.poster ? [body.poster] : [])].map((v) => `${activityid}/${v}`);
  if (body.type === 'video' && !body.poster) throw errors.BadRequest('A video needs its poster', ErrorCode.BAD_MEDIA);
  if (body.type === 'photo' && body.poster) throw errors.BadRequest('A photo has no poster', ErrorCode.BAD_MEDIA);
  try {
    await checkFile(activityid, body.value, body.type);
    if (body.poster) await checkFile(activityid, body.poster, 'poster');
  } catch (e) {
    await deleteObjects(uploaded).catch(() => {}); // a refused upload leaves nothing behind
    throw e;
  }
  const item = { type: body.type, value: body.value, dimension: body.dimension, ...(body.duration !== undefined ? { duration: body.duration } : {}), ...(body.poster ? { poster: body.poster } : {}), ...(body.blur ? { blur: body.blur } : {}) };
  const { table, id } = OWNER_TABLE[kind];
  const r = await app.pg.writer.query(appendSql(table, id), [activityid, userid, body.value, JSON.stringify([item]), MAX_MEDIA_PER_ACTIVITY]);
  if (!r.rowCount) {
    // The activity was deleted meanwhile, or it already has the most media it may have.
    await deleteObjects(uploaded).catch(() => {});
    if (await ownerKind(app, userid, activityid)) throw errors.Conflict(`An activity may have at most ${MAX_MEDIA_PER_ACTIVITY} photos and videos`, ErrorCode.MEDIA_LIMIT);
    throw errors.NotFound('No such activity', ErrorCode.NOT_FOUND);
  }
  return r.rows[0].media_v2 as unknown[];
}
