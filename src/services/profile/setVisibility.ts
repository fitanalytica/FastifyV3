import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';

// docs/data/api.md section 7c. Public or private (`userinfo.hideprofile`). The feed, other people's profiles and a single feed activity all read it per request, so
// there is nothing to clean up: a hidden user simply stops being served. Repeating a call changes nothing. A user with no profile row yet (the new-user setup is not
// saved) gets a 404, and the phone sends it again after the profile.
export async function setVisibility(app: FastifyInstance, userid: string, hidden: boolean): Promise<{ hidden: boolean }> {
  const r = await app.pg.writer.query('UPDATE userinfo SET hideprofile = $2 WHERE userid = $1', [userid, hidden]);
  if (!r.rowCount) throw errors.NotFound('No profile yet', ErrorCode.NOT_FOUND);
  return { hidden };
}
