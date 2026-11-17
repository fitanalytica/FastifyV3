import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { RefreshBody, Tokens } from '../../types/index.js';
import { now, rand, sha, signAccess } from './tokenUtils.js';

/** Refresh with a 2-minute grace for the previous refresh value (docs/data/server.md section 10). */
export async function refreshAuthTokens(app: FastifyInstance, body: RefreshBody): Promise<Tokens> {
  const refreshValue = body.refreshToken;
  const access = rand(), refresh = rand(), t = now();
  const h = sha(refreshValue);
  const r = await app.pg.writer.query(
    `UPDATE usertokens SET
       prev_refresh_token = CASE WHEN refresh_token = ANY($1) THEN refresh_token ELSE prev_refresh_token END,
       prev_changed_date  = CASE WHEN refresh_token = ANY($1) THEN $4 ELSE prev_changed_date END,
       access_token = $2, refresh_token = $3, changed_date = $4
     WHERE revoked = FALSE
       AND (refresh_token = ANY($1) OR (prev_refresh_token = $5 AND prev_changed_date > $4 - 120))
     RETURNING userid`,
    [[h, refreshValue], sha(access), sha(refresh), t, h],
  );
  if (!r.rows.length) throw errors.Unauthorized('Refresh refused', ErrorCode.LOGOUT);
  return { accessToken: signAccess(app, access), refreshToken: refresh };
}
