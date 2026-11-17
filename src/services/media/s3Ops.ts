import { DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { s3 } from './s3Client.js';

// The few S3 calls the media routes make besides signing. Only these touch S3 over the network. `bucket` is the activity media (default) or the
// profile pictures and covers.
export type Bucket = 'media' | 'profile';
const bucketName = (b: Bucket) => (b === 'profile' ? env().s3.bucketProfile : env().s3.bucketMedia);

/** The size and content type of an object, or null when it is not there. */
export async function headObject(key: string, bucket: Bucket = 'media'): Promise<{ size: number; contentType: string | undefined } | null> {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: bucketName(bucket), Key: key }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType };
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw e;
  }
}

/** Deletes objects of the media bucket (up to 1000 at a time). A key that is not there is not an error. */
export async function deleteObjects(keys: string[], bucket: Bucket = 'media'): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3().send(new DeleteObjectsCommand({
      Bucket: bucketName(bucket),
      Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
  }
}

/** Deletes everything under `<activityid>/`: the files of an activity that was deleted (old media too). */
export async function deleteFolder(activityid: string): Promise<number> {
  let token: string | undefined;
  let count = 0;
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: env().s3.bucketMedia, Prefix: `${activityid}/`, ContinuationToken: token }));
    const keys = (r.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    if (keys.length) await deleteObjects(keys);
    count += keys.length;
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return count;
}
