/** Every environment variable the server reads, checked in one place. */
export interface Env {
  port: number;
  /** Signs the access JWTs. */
  jwtSecret: string;
  /** How long an access JWT lives, e.g. '7d'. */
  jwtExpiry: string;
  pgWriterUrl: string;
  pgReaderUrl: string;
  pgSsl: boolean;
  /** Local testing only: enables POST /phone/v3/auth/dev-login. */
  devLogin: boolean;
  /** Local testing only: which user dev-login signs in as for `provider: 'apple'` / `'google'` (a userid already in the local database). */
  devUsers: { apple?: string; google?: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUIRED = ['JWE_SECRET', 'PG_WRITER_URL', 'PG_READER_URL'] as const;

function devUser(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  if (!UUID.test(v)) throw new Error(`${name} must be a userid (uuid), got "${v}"`);
  return v.toLowerCase();
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
    pgWriterUrl: e.PG_WRITER_URL!,
    pgReaderUrl: e.PG_READER_URL!,
    pgSsl: e.PG_SSL === 'true',
    devLogin: e.DEV_LOGIN === 'true',
    devUsers: { apple: devUser('DEV_USER_APPLE'), google: devUser('DEV_USER_GOOGLE') },
  };
}
