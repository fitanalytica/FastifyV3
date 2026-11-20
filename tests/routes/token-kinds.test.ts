import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { loginDevice } from '../../src/services/auth/loginDevice.js';
import { PHONE_BATCH, WEARABLE_BATCH, activity, activityRow, bearer } from '../helpers/fixtures.js';
import { phoneBatch, probe, probeWatch, whoami } from '../helpers/viaSync.js';

let app: TestApp;
let acc: Account;
beforeAll(async () => { app = await build(); acc = await createAccount(app); });
afterAll(async () => { await acc.remove(); await app.close(); });

const post = (url: string, token: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: bearer(token), payload });
const get = (url: string, token: string) => app.inject({ url, headers: bearer(token) });

test('phone and wearable routes each accept only their own kind of token', async () => {
  const a = activity(acc.phoneDownloadid);
  expect((await phoneBatch(app, acc.watchToken, [a])).json()).toMatchObject({ statusCode: 403, code: 'WRONG_DEVICE' });
  expect((await post(WEARABLE_BATCH, acc.phoneToken, { activities: [a] })).json()).toMatchObject({ statusCode: 403, code: 'WRONG_DEVICE' });
  expect(await activityRow(app, a.activityid)).toBeUndefined();

  expect(await whoami(app, acc.phoneToken)).toEqual({ userid: acc.userid, deviceType: 'phone' });
  expect((await probeWatch(app, acc.watchToken)).statusCode).toBe(200);
  expect((await probeWatch(app, acc.phoneToken)).json().code).toBe('WRONG_DEVICE');
  expect((await post('/phone/v3/auth/logout', acc.watchToken)).json().code).toBe('WRONG_DEVICE');
});

test('refresh works on both sides, with the matching refresh token', async () => {
  const mine = await acc.login(acc.watchDownloadid);
  const r = await app.inject({ method: 'POST', url: '/wearable/v3/auth/refresh', payload: { refreshToken: mine.refreshToken } });
  expect(r.statusCode).toBe(200);
  expect((await probeWatch(app, r.json().accessToken)).statusCode).toBe(200);
});

test('there are no unprefixed or unversioned paths', async () => {
  for (const url of ['/v3/activities/batch', '/phone/activities/batch', '/activities/batch']) {
    expect((await post(url, acc.phoneToken)).json().code).toBe('NOT_FOUND');
  }
});

test('v3 serves the phone and the watch only: a tablet is the phone side, chrome, mac and an untyped device are refused on both', async () => {
  const device = async (type: string | null) => {
    const downloadid = randomUUID();
    await app.pg.writer.query('INSERT INTO downloads (downloadid, userid, device_type) VALUES ($1, $2, $3)', [downloadid, acc.userid, type]);
    const t = await loginDevice(app, { deviceid: randomUUID(), userid: acc.userid, downloadid, applegoogleid: 'test-' + acc.userid.slice(0, 8), device: 'x' });
    return { token: t.accessToken, downloadid };
  };
  try {
    const tablet = await device('tablet');
    expect(await whoami(app, tablet.token)).toEqual({ userid: acc.userid, deviceType: 'tablet' });
    expect((await probeWatch(app, tablet.token)).json().code).toBe('WRONG_DEVICE');
    for (const type of ['chrome', 'mac', null]) {
      const d = await device(type);
      for (const [url, call] of [['phone', () => probe(app, d.token)], ['wearable', () => probeWatch(app, d.token)]] as const) {
        const res = await call();
        expect(res.statusCode, `${type} ${url}`).toBe(403);
        expect(res.json().code).toBe('WRONG_DEVICE');
      }
      expect((await phoneBatch(app, d.token, [activity(d.downloadid)])).json().code).toBe('WRONG_DEVICE');
    }
  } finally {
    await app.pg.writer.query(`DELETE FROM usertokens WHERE userid = $1 AND downloadid NOT IN ($2, $3)`, [acc.userid, acc.phoneDownloadid, acc.watchDownloadid]);
    await app.pg.writer.query(`DELETE FROM downloads WHERE userid = $1 AND downloadid NOT IN ($2, $3)`, [acc.userid, acc.phoneDownloadid, acc.watchDownloadid]);
  }
});
