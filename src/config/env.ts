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
  /** Sign in with Apple and Google (docs/data/api.md section 1b). Without a client id for a provider, its login answers 503. The key is never committed. */
  apple: { clientId: string; /** The App Store's numeric id of the app (APPLE_APP_ID): needed to check production purchases and notifications. */ appId?: number; teamId?: string; keyId?: string; privateKeyPath?: string; privateKey?: string };
  google: { clientIds: string[] };
  /** E-mail goes out through an SNS topic that something else turns into mail (docs/data/api.md section 8b). Without `topicArn` no e-mail is sent. Credentials: the server's role, or AWS_* variables locally. */
  sns: { topicArn?: string; region: string };
  /** How many sign-ins one address may try in a minute (the sign-in route is open to anyone, so it is limited more than the rest). */
  loginRateLimit: number;
  /** Which billing tables the Pro state reads (docs/data/api.md section 15): `production` (the default), `sandbox` (the `_sandbox` copies) or `both` (a server that also serves TestFlight and App Review). */
  billingEnv: 'production' | 'sandbox' | 'both';
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

const base64Key = (value: string | undefined) => (value ? Buffer.from(value, 'base64').toString('utf8') : undefined);

const DEFAULT_REFRESH_GRACE = 30 * 24 * 3600;

function refreshGrace(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_REFRESH_GRACE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`REFRESH_GRACE_SECONDS must be a whole number of seconds, got "${value}"`);
  return n;
}

function billingEnv(value: string | undefined): 'production' | 'sandbox' | 'both' {
  if (!value) return 'production';
  if (value === 'production' || value === 'sandbox' || value === 'both') return value;
  throw new Error(`BILLING_ENV must be production, sandbox or both, got "${value}"`);
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
    apple: {
      clientId: e.APPLE_CLIENT_ID || 'com.fitanalytica',
      appId: Number(e.APPLE_APP_ID) > 0 ? Number(e.APPLE_APP_ID) : undefined,
      teamId: e.APPLE_TEAM_ID || undefined,
      keyId: e.APPLE_KEY_ID || e.APPLE_SIGNIN_KEYID || undefined,
      privateKeyPath: e.APPLE_PRIVATE_KEY_PATH || undefined,
      // The Key as PEM text, or the same PEM as base64 (easier in an environment file than a text with line breaks).
      privateKey: e.APPLE_PRIVATE_KEY || (base64Key(e.APPLE_SIGNIN_PRIVATE_KEY_BASE64 || e.APPLE_PRIVATE_KEY_BASE64)),
    },
    sns: { topicArn: e.SNS_ARN || undefined, region: e.SNS_REGION || 'us-east-1' },
    loginRateLimit: Number(e.LOGIN_RATE_LIMIT) > 0 ? Number(e.LOGIN_RATE_LIMIT) : 20,
    billingEnv: billingEnv(e.BILLING_ENV),
    google: { clientIds: (e.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean) },
  };
}
