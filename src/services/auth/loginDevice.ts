import type { FastifyInstance } from 'fastify';
import type { LoginInput, Tokens } from '../../types/index.js';
import { now, rand, sha, signAccess } from './tokenUtils.js';

/** Login core: one row per device (deviceid). A repeat login replaces the tokens and clears `revoked`. */
export async function loginDevice(app: FastifyInstance, i: LoginInput): Promise<Tokens> {
  const access = rand(), refresh = rand();
  await app.pg.writer.query(
    `INSERT INTO usertokens (deviceid, userid, downloadid, applegoogleid, device, access_token, refresh_token, revoked, changed_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8)
     ON CONFLICT (deviceid) DO UPDATE SET userid = EXCLUDED.userid, downloadid = EXCLUDED.downloadid,
       applegoogleid = EXCLUDED.applegoogleid, device = EXCLUDED.device, access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token, revoked = FALSE, changed_date = EXCLUDED.changed_date,
       prev_refresh_token = NULL, prev_changed_date = NULL`,
    [i.deviceid, i.userid, i.downloadid, i.applegoogleid, i.device, sha(access), sha(refresh), now()],
  );
  return { accessToken: signAccess(app, access), refreshToken: refresh };
}
