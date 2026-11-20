import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { DevLoginResponse, WatchTokenBody } from '../../types/index.js';
import { registerDownload } from './downloads.js';
import { loginDevice } from './loginDevice.js';

/**
 * The phone gives the watch its own sign-in (`POST /auth/watch-token`, docs/data/watch.md section 2, api.md section 1d). The watch has its own download row (made when it was installed) and its own
 * device id; **the moment its own tokens are made, its row gets the user's id** (and the row is made here if the watch never called in). The phone's row says a watch is paired. The watch's
 * device id must not be the phone's: a token row is one per device id, so the same id would sign the phone out. Never the phone's own token is copied to the watch.
 */
export async function watchToken(app: FastifyInstance, userid: string, phoneDownloadid: string, b: WatchTokenBody, ip: string): Promise<DevLoginResponse> {
  const w = app.pg.writer;
  const phone = await w.query('SELECT 1 FROM usertokens WHERE userid = $1 AND downloadid = $2 AND deviceid = $3', [userid, phoneDownloadid, b.deviceid]);
  if (phone.rowCount) throw errors.BadRequest("The watch's device id is the phone's", ErrorCode.BAD_REQUEST);
  const login = await w.query('SELECT applegoogleid FROM userlogin WHERE userid = $1', [userid]);
  if (!login.rowCount) throw errors.NotFound('No such user', ErrorCode.NOT_FOUND);
  const downloadid = b.downloadid ?? randomUUID();
  await registerDownload(app, { downloadid, userid, deviceid: b.deviceid, platform: b.platform, watch: true, info: b.deviceInfo, ip });
  const tokens = await loginDevice(app, { deviceid: b.deviceid, userid, downloadid, applegoogleid: login.rows[0].applegoogleid, device: b.device ?? 'watch' });
  await w.query('UPDATE downloads SET is_watch_paired = TRUE WHERE downloadid = $1 AND userid = $2', [phoneDownloadid, userid]);
  return { ...tokens, userid, downloadid };
}
