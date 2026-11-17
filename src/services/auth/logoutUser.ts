import type { FastifyInstance } from 'fastify';
import type { LogoutBody, LogoutResponse } from '../../types/index.js';
import { knownTokens, sha } from './tokenUtils.js';

/** With a refresh token: that device only. Without: every device of the user. */
export async function logoutUser(app: FastifyInstance, userid: string, body: LogoutBody): Promise<LogoutResponse> {
  const refreshValue = body.refreshToken;
  const r = refreshValue
    ? await app.pg.writer.query(
        `UPDATE usertokens SET revoked = TRUE WHERE userid = $1 AND refresh_token = ANY($2) RETURNING access_token`,
        [userid, [sha(refreshValue), refreshValue]])
    : await app.pg.writer.query(
        `UPDATE usertokens SET revoked = TRUE WHERE userid = $1 RETURNING access_token`, [userid]);
  for (const row of r.rows) knownTokens.delete(String(row.access_token).trim());
  return { revoked: r.rowCount ?? 0 };
}
