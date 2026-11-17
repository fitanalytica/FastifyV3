import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { AuthInfo } from '../../types/index.js';
import { knownTokens, now, sha, unknownTokens } from './tokenUtils.js';

const LOOKUP = `
  SELECT t.userid, t.downloadid, d.device_type::text AS device_type, t.accessed_date
    FROM usertokens t LEFT JOIN downloads d ON d.downloadid = t.downloadid
   WHERE t.access_token = ANY($1) AND t.revoked = FALSE`;

async function lookup(app: FastifyInstance, accessValue: string): Promise<AuthInfo | null> {
  const key = sha(accessValue);
  const hit = knownTokens.get(key);
  if (hit) return hit;
  if (unknownTokens.get(key)) return null;
  const args = [[key, accessValue]]; // the hash, or the raw value of an older row
  // The reader can lag behind the writer: a token created a moment ago may be missing there.
  // Ask the writer before answering LOGOUT.
  let r = await app.pg.reader.query(LOOKUP, args);
  if (!r.rows.length) r = await app.pg.writer.query(LOOKUP, args);
  if (!r.rows.length) { unknownTokens.set(key, true); return null; }
  const row = r.rows[0];
  const info: AuthInfo = { userid: row.userid, downloadid: row.downloadid, deviceType: row.device_type };
  knownTokens.set(key, info);
  // accessed_date is only written when it is more than an hour old.
  if (!row.accessed_date || now() - Number(row.accessed_date) > 3600) {
    app.pg.writer.query('UPDATE usertokens SET accessed_date = $2 WHERE access_token = ANY($1)', [[key, accessValue], now()]).catch(() => {});
  }
  return info;
}

type JwtPayload = { access_token?: string };

/** Checks `Authorization: Bearer <jwt>` and returns who the request is for. */
export async function checkAccess(app: FastifyInstance, header: string | undefined): Promise<AuthInfo> {
  if (!header || !/^Bearer\s+\S+$/.test(header)) throw errors.BadRequest('Not Bearer <token>', ErrorCode.INVALID_TOKEN_FORMAT);
  const jwt = header.split(/\s+/)[1];
  let accessValue: string | undefined;
  let expired = false;
  try {
    accessValue = (app.jwt.verify(jwt) as JwtPayload).access_token;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'FAST_JWT_EXPIRED' || code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') {
      expired = true;
      accessValue = (app.jwt.decode(jwt) as JwtPayload | null)?.access_token;
    }
  }
  if (!accessValue) throw errors.Unauthorized('Invalid token', ErrorCode.LOGOUT);
  const info = await lookup(app, accessValue);
  if (!info) throw errors.Unauthorized('Unknown or revoked token', ErrorCode.LOGOUT);
  if (expired) throw errors.Unauthorized('Token expired', ErrorCode.TOKEN_EXPIRED);
  return info;
}
