import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { PresignBody } from '../../types/index.js';
import { EXTENSION, MAX_BYTES, UPLOAD_URL_SECONDS } from './limits.js';
import { ownerKind } from './owner.js';
import { s3 } from './s3Client.js';

// docs/data/api.md section 6, step 1. The file never goes through the API: the phone gets an address to PUT it to, signed for exactly this key,
// content type and length, valid for 15 minutes. The server chooses the name (`<uuid>.<ext>`), so the phone cannot overwrite or guess another file.

/** The user must own the activity or post and it must not be deleted. */
export async function ownsActivity(app: FastifyInstance, userid: string, id: string): Promise<boolean> {
  return Boolean(await ownerKind(app, userid, id));
}

export interface Presigned {
  value: string;
  url: string;
  headers: Record<string, string>;
}

export async function presign(app: FastifyInstance, userid: string, activityid: string, body: PresignBody): Promise<Presigned> {
  const ext = EXTENSION[body.role][body.contentType];
  if (!ext) throw errors.BadRequest(`${body.contentType} is not allowed for a ${body.role}`, ErrorCode.BAD_MEDIA);
  if (body.bytes > MAX_BYTES[body.role]) throw errors.BadRequest(`A ${body.role} may be at most ${MAX_BYTES[body.role]} bytes`, ErrorCode.BAD_MEDIA);
  if (!(await ownsActivity(app, userid, activityid))) throw errors.NotFound('No such activity', ErrorCode.NOT_FOUND);
  const value = `${randomUUID()}.${ext}`;
  const command = new PutObjectCommand({ Bucket: env().s3.bucketMedia, Key: `${activityid}/${value}`, ContentType: body.contentType, ContentLength: body.bytes });
  const url = await getSignedUrl(s3(), command, {
    expiresIn: UPLOAD_URL_SECONDS,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return { value, url, headers: { 'Content-Type': body.contentType } };
}
