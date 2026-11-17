import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { RefreshBody, Tokens } from '../../types/index.js';
import { env } from '../../config/env.js';
import { now, rand, sha, signAccess } from './tokenUtils.js';

/**
 * Refresh with a grace for the previous refresh value (docs/data/server.md section 10). A refresh whose reply is lost (the app was killed or reloaded between the
 * server rotating and the phone saving) must never sign the user out, however long it is before the phone tries again: in production the previous value works for
 * 30 days (`REFRESH_GRACE_SECONDS`, 30 days when unset; a short one in local testing). The window slides: each retry with the previous value moves it on, and using
 * the current value replaces the previous one.
 */
export async function refreshAuthTokens(app: FastifyInstance, body: RefreshBody): Promise<Tokens> {
  const refreshValue = body.refreshToken;
  const access = rand(), refresh = rand(), t = now();
  const h = sha(refreshValue);
  const r = await app.pg.writer.query(
    `UPDATE usertokens SET
       prev_refresh_token = CASE WHEN refresh_token = ANY($1) THEN refresh_token ELSE prev_refresh_token END,
       prev_changed_date  = $4,
       access_token = $2, refresh_token = $3, changed_date = $4
     WHERE revoked = FALSE
       AND (refresh_token = ANY($1) OR (prev_refresh_token = $5 AND prev_changed_date > $4::bigint - $6::bigint))
     RETURNING userid`,
    [[h, refreshValue], sha(access), sha(refresh), t, h, env().refreshGraceSeconds],
  );
  if (!r.rows.length) throw errors.Unauthorized('Refresh refused', ErrorCode.LOGOUT);
  return { accessToken: signAccess(app, access), refreshToken: refresh };
}
