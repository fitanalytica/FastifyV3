import { randomUUID } from 'node:crypto';
import { build } from '../../src/app.js';
import { loginDevice } from '../../src/services/auth/loginDevice.js';

export type TestApp = Awaited<ReturnType<typeof build>>;
export { build };

/** A user with a phone and a watch (each its own `downloads` row and token), made in the local database and removed again. */
export interface Account {
  userid: string;
  phoneDownloadid: string;
  watchDownloadid: string;
  phoneToken: string;
  watchToken: string;
  login(downloadid: string): Promise<{ accessToken: string; refreshToken: string }>;
  remove(): Promise<void>;
}

export async function createAccount(app: TestApp): Promise<Account> {
  const userid = randomUUID(), phoneDownloadid = randomUUID(), watchDownloadid = randomUUID();
  const applegoogleid = 'test-' + userid.slice(0, 8);
  const w = app.pg.writer;
  await w.query('INSERT INTO userlogin (userid, stage, applegoogleid) VALUES ($1, 0, $2)', [userid, applegoogleid]);
  await w.query(`INSERT INTO downloads (downloadid, userid, device_type) VALUES ($1, $3, 'phone'), ($2, $3, 'watch')`, [phoneDownloadid, watchDownloadid, userid]);
  const login = (downloadid: string) => loginDevice(app, { deviceid: randomUUID(), userid, downloadid, applegoogleid, device: 'test' });
  return {
    userid, phoneDownloadid, watchDownloadid,
    phoneToken: (await login(phoneDownloadid)).accessToken,
    watchToken: (await login(watchDownloadid)).accessToken,
    login,
    async remove() {
      await w.query('DELETE FROM userlogin WHERE userid = $1', [userid]); // cascades activities and tokens
      await w.query('DELETE FROM downloads WHERE downloadid = ANY($1)', [[phoneDownloadid, watchDownloadid]]);
    },
  };
}
