import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { DevLoginBody, DevLoginResponse } from '../../types/index.js';
import { loginDevice } from './loginDevice.js';

const DEV_APPLEGOOGLEID = 'dev-user';

/** The user to sign in as: the one asked for by `userid` (it must already be in the local database, for example imported from production),
 *  else the one mapped to `provider` in the env, else the fixed 'dev-user', made on first use. */
async function devUserFor(app: FastifyInstance, body: Pick<DevLoginBody, 'provider' | 'userid'>): Promise<{ userid: string; applegoogleid: string }> {
  const w = app.pg.writer;
  if (body.userid) {
    const r = await w.query('SELECT userid, applegoogleid FROM userlogin WHERE userid = $1', [body.userid]);
    if (!r.rowCount) throw errors.BadRequest('That user is not in the local database', ErrorCode.BAD_REQUEST);
    return { userid: r.rows[0].userid, applegoogleid: r.rows[0].applegoogleid };
  }
  const mapped = body.provider ? env().devUsers[body.provider] : undefined;
  if (mapped) {
    const r = await w.query('SELECT userid, applegoogleid FROM userlogin WHERE userid = $1', [mapped]);
    if (r.rowCount) return { userid: r.rows[0].userid, applegoogleid: r.rows[0].applegoogleid };
  }
  const u = await w.query(
    `INSERT INTO userlogin (userid, stage, applegoogleid) VALUES ($1, 0, $2)
     ON CONFLICT (applegoogleid) DO UPDATE SET stage = userlogin.stage RETURNING userid`, [randomUUID(), DEV_APPLEGOOGLEID]);
  return { userid: u.rows[0].userid, applegoogleid: DEV_APPLEGOOGLEID };
}

/** The `downloads.platform` of a device: a watch is watchos (Apple) or wearos (Android). */
const platformFor = (android: boolean, watch: boolean) => (watch ? (android ? 'wearos' : 'watchos') : android ? 'android' : 'ios');

/** LOCAL TESTING ONLY (DEV_LOGIN=true; otherwise it answers like an unknown route).
 *  Signs in a fixed dev user, with no Apple/Google check, through the same loginDevice as the real login. */
export async function devLogin(app: FastifyInstance, b: DevLoginBody): Promise<DevLoginResponse> {
  if (!env().devLogin) throw errors.NotFound('Route not found', ErrorCode.NOT_FOUND);
  const downloadid = b.downloadid ?? randomUUID();
  const w = app.pg.writer;
  const { userid, applegoogleid } = await devUserFor(app, b);
  await w.query(
    `INSERT INTO downloads (downloadid, userid, device_type, platform)
     VALUES ($1, $2, $3, $4) ON CONFLICT (downloadid) DO UPDATE SET userid = EXCLUDED.userid`,
    [downloadid, userid, b.watch ? 'watch' : 'phone', platformFor(b.platform === 'android', Boolean(b.watch))]);
  const tokens = await loginDevice(app, { deviceid: b.deviceid, userid, downloadid, applegoogleid, device: b.device ?? 'dev' });
  return { ...tokens, userid, downloadid };
}
