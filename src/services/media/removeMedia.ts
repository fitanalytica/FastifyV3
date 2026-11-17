import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { OWNER_TABLE, ownerKind } from './owner.js';
import { deleteObjects } from './s3Ops.js';

// docs/data/api.md section 6. Removes one file from an activity or a post: out of `media_v2` (and out of an old row's `media` names) in one statement, then
// its files from S3 (the file, and the poster of a video). Idempotent: a value that is not in the list is still 204, and its file is still removed
// (it may be an upload that was never committed). The files go after the row is changed: a failed S3 delete leaves an orphan, never a broken activity.

// An activity may also have an old row's `media` (a list of names); a post never does. Only the table and its id column differ (owner.ts: fixed words).
const posterSql = (table: string, id: string) => `
  SELECT e->>'poster' AS poster FROM ${table} a, jsonb_array_elements(coalesce(a.media_v2, '[]'::jsonb)) e
   WHERE a.${id} = $1 AND a.userid = $2 AND e->>'value' = $3`;

const removeSql = (kind: 'activity' | 'post') => {
  const { table, id } = OWNER_TABLE[kind];
  const oldMedia = kind === 'activity'
    ? `,
    media = CASE WHEN media IS NULL OR jsonb_typeof(media) <> 'array' THEN media
                 ELSE (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(media) e WHERE e #>> '{}' IS DISTINCT FROM $3) END`
    : '';
  return `
  UPDATE ${table} SET
    media_v2 = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(coalesce(media_v2, '[]'::jsonb)) e WHERE e->>'value' IS DISTINCT FROM $3)${oldMedia}
  WHERE ${id} = $1 AND userid = $2 AND tosend > 0`;
};

export async function removeMedia(app: FastifyInstance, userid: string, activityid: string, value: string): Promise<void> {
  const kind = await ownerKind(app, userid, activityid);
  if (!kind) throw errors.NotFound('No such activity', ErrorCode.NOT_FOUND);
  const w = app.pg.writer;
  const { table, id } = OWNER_TABLE[kind];
  const poster = (await w.query(posterSql(table, id), [activityid, userid, value])).rows[0]?.poster as string | null | undefined;
  await w.query(removeSql(kind), [activityid, userid, value]);
  const keys = [value, ...(poster ? [poster] : [])].map((v) => `${activityid}/${v}`);
  await deleteObjects(keys).catch((e) => app.log.error({ err: e, activityid }, 'media files not deleted from S3 (orphans)'));
}
