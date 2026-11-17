import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';

// One client for the process, made on first use (the config is read then, so a test can set it first). Signing a URL is local arithmetic:
// it makes no request to S3.
let client: S3Client | undefined;
let key = '';

export function s3(): S3Client {
  const c = env().s3;
  const id = JSON.stringify(c);
  if (!client || id !== key) {
    client = new S3Client({
      region: c.region,
      ...(c.endpoint ? { endpoint: c.endpoint } : {}),
      forcePathStyle: c.forcePathStyle,
      ...(c.accessKeyId && c.secretAccessKey ? { credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } } : {}),
    });
    key = id;
  }
  return client;
}
