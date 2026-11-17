// Fills the local MinIO with real sample photos (from picsum.photos) in varied shapes, tall, wide and square, for the media the local database mentions,
// so the app has images to load and the layouts can be tried on every aspect ratio.
//
//   node docs/data/dev-s3/seed.mjs            (DB=fitanalytica_dev, MinIO on localhost:9000)
//
// For every activity that lists media (the old `media` names and `media_v2` photos) it uploads one picture under `activitees/<activityid>/<name>`. The photo and
// its shape are picked from the name, so a file always looks the same. A `media_v2` item with a `dimension` gets that shape. Your own photos are never copied:
// these are JPEG bytes under the real names (the phone reads a picture from its bytes, not its name). If picsum.photos cannot be reached it falls back to a
// coloured picture. Safe to run again. It only ever talks to a local endpoint.
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
if (!/localhost|127\.0\.0\.1|10\.0\.2\.2/.test(endpoint)) throw new Error(`Refusing to seed ${endpoint}: this only fills a local stand-in.`);
const db = process.env.DB ?? 'fitanalytica_dev';

// Shapes (width, height) of a phone gallery: tall, wide and square. Photo ids that exist on picsum.photos.
const SHAPES = [[800, 1000], [1000, 600], [800, 800], [600, 900], [900, 600], [800, 1100], [1100, 620], [700, 700], [640, 960], [1000, 750]];
const PICSUM = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60];
const fetched = new Map();

/** A real photo of the shape, or null when picsum.photos cannot be reached. Asked for once per photo and shape. */
async function photo(id, [w, h]) {
  const key = `${id}/${w}/${h}`;
  if (!fetched.has(key)) {
    let bytes = null;
    try {
      const res = await fetch(`https://picsum.photos/id/${id}/${w}/${h}.jpg`, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
    } catch { /* offline: the fallback is used */ }
    fetched.set(key, bytes);
  }
  return fetched.get(key);
}

const s3 = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
const client = new pg.Client({ connectionString: `postgres://api_writer:dev@localhost:5432/${db}` });

function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6].map((c) => Math.round(c * 255));
}

function png(width, height, hue) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(hsv((hue + (x / width) * 0.12) % 1, 0.55, 0.55 + 0.4 * (1 - y / height)), 1 + x * 3);
    rows.push(row);
  }
  const chunk = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

try {
  for (const Bucket of ['activitees', 'fitpy']) {
    try { await s3.send(new CreateBucketCommand({ Bucket })); } catch (e) { if (!/BucketAlready/.test(e.name)) throw new Error(`Cannot reach MinIO at ${endpoint} (${e.message}). Is \`sh docs/data/dev-s3/run.sh\` running?`); }
  }
  await client.connect();
  const { rows } = await client.query(
    `SELECT activityid, coalesce(media, '[]'::jsonb) AS old, coalesce(media_v2, '[]'::jsonb) AS new FROM activities
      WHERE tosend > 0 AND (jsonb_array_length(coalesce(media, '[]'::jsonb)) > 0 OR jsonb_array_length(coalesce(media_v2, '[]'::jsonb)) > 0)`);
  let count = 0;
  let fallbacks = 0;
  for (const r of rows) {
    const files = [
      ...r.old.filter((n) => typeof n === 'string').map((name) => ({ name })),
      ...r.new.filter((i) => i?.type === 'photo' && i.value).map((i) => ({ name: i.value, dimension: i.dimension })),
    ];
    for (const { name, dimension } of files) {
      const n = parseInt(createHash('sha1').update(name).digest('hex').slice(0, 8), 16);
      const shape = Array.isArray(dimension) && dimension[0] > 0 && dimension[1] > 0 ? [Math.min(dimension[0], 1100), Math.min(dimension[1], 1100)] : SHAPES[n % SHAPES.length];
      const real = await photo(PICSUM[Math.floor(n / SHAPES.length) % PICSUM.length], shape);
      const body = real ?? png(240, 180, (n % 1000) / 1000);
      await s3.send(new PutObjectCommand({ Bucket: 'activitees', Key: `${r.activityid}/${name}`, Body: body, ContentType: real ? 'image/jpeg' : 'image/png' }));
      count++;
      if (!real) fallbacks++;
    }
  }
  // The profile pictures and covers the local database names, in `fitpy` (a square picture, a wide cover).
  const profiles = (await client.query('SELECT profilepic, profilebg FROM userinfo')).rows;
  let profileCount = 0;
  for (const { profilepic, profilebg } of profiles) {
    for (const [name, shape] of [[profilepic, [512, 512]], [profilebg, [1200, 600]]]) {
      if (!name) continue;
      const n = parseInt(createHash('sha1').update(name).digest('hex').slice(0, 8), 16);
      const real = await photo(PICSUM[n % PICSUM.length], shape);
      await s3.send(new PutObjectCommand({ Bucket: 'fitpy', Key: name, Body: real ?? png(240, 180, (n % 1000) / 1000), ContentType: real ? 'image/jpeg' : 'image/png' }));
      profileCount++;
    }
  }
  console.log(`${profileCount} profile pictures and covers in fitpy`);
  console.log(`${count} pictures in activitees, from ${rows.length} activities${fallbacks ? ` (${fallbacks} fell back to a coloured picture: picsum.photos was not reachable)` : ''}`);
} finally {
  await client.end();
}
