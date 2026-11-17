/** Every environment variable the server reads, checked in one place. */
export interface Env {
  port: number;
  /** Signs the access JWTs. */
  jwtSecret: string;
  /** How long an access JWT lives, e.g. '7d'. */
  jwtExpiry: string;
  /** How long the previous refresh value still works after a rotation, in seconds (docs/data/server.md section 10). 30 days in production; short in local testing. */
  refreshGraceSeconds: number;
  pgWriterUrl: string;
  pgReaderUrl: string;
  pgSsl: boolean;
  /** Local testing only: enables POST /phone/v3/auth/dev-login. */
  devLogin: boolean;
  /** Local testing only: which user dev-login signs in as for `provider: 'apple'` / `'google'` (a userid already in the local database). */
  devUsers: { apple?: string; google?: string };
  s3: S3Env;
  /** The weather providers' keys (docs/data/api.md section 13). Without both the weather route answers 503. Never committed: they are set in the environment. */
  weather: { weatherApiKey?: string; openWeatherKey?: string };
}

/** Where the media lives (docs/data/server.md section 6). In production only the region is set: the credentials come from the server's role. */
export interface S3Env {
  region: string;
  /** Local testing only: a stand-in such as MinIO (http://localhost:9000). Unset means real AWS. */
  endpoint?: string;
  /** A stand-in needs `bucket` in the path, not in the host. */
  forcePathStyle: boolean;
  /** Local testing only. Unset in production. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Activity photos and videos: `<activityid>/<file>`. */
  bucketMedia: string;
  /** Profile pictures and covers: `<file>`. */
  bucketProfile: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUIRED = ['JWE_SECRET', 'PG_WRITER_URL', 'PG_READER_URL'] as const;

function devUser(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  if (!UUID.test(v)) throw new Error(`${name} must be a userid (uuid), got "${v}"`);
  return v.toLowerCase();
}

const DEFAULT_REFRESH_GRACE = 30 * 24 * 3600;

function refreshGrace(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_REFRESH_GRACE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`REFRESH_GRACE_SECONDS must be a whole number of seconds, got "${value}"`);
  return n;
}

/** Read on each call (it is cheap) so a test can change a variable. `build()` calls it first, so a missing variable stops the start with a clear message. */
export function env(): Env {
  const e = process.env;
  const missing = REQUIRED.filter((k) => !e[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const port = Number(e.PORT ?? 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a port number, got "${e.PORT}"`);
  return {
    port,
    jwtSecret: e.JWE_SECRET!,
    jwtExpiry: e.JWT_EXPIRY ?? '7d',
    refreshGraceSeconds: refreshGrace(e.REFRESH_GRACE_SECONDS),
    pgWriterUrl: e.PG_WRITER_URL!,
    pgReaderUrl: e.PG_READER_URL!,
    pgSsl: e.PG_SSL === 'true',
    devLogin: e.DEV_LOGIN === 'true',
    devUsers: { apple: devUser('DEV_USER_APPLE'), google: devUser('DEV_USER_GOOGLE') },
    s3: {
      region: e.S3_REGION ?? 'us-east-1',
      endpoint: e.S3_ENDPOINT || undefined,
      forcePathStyle: e.S3_FORCE_PATH_STYLE === 'true',
      accessKeyId: e.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY || undefined,
      bucketMedia: e.S3_BUCKET_MEDIA ?? 'activitees',
      bucketProfile: e.S3_BUCKET_PROFILE ?? 'fitpy',
    },
    weather: { weatherApiKey: e.WEATHER_API || undefined, openWeatherKey: e.OPEN_WEATHER_API || undefined },
  };
}
