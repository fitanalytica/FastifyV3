import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { checkAccess } from '../../../src/services/auth/checkAccess.js';
import { loginDevice } from '../../../src/services/auth/loginDevice.js';
import { clearAuthCache } from '../../../src/services/auth/tokenUtils.js';
import { bearer } from '../../helpers/fixtures.js';

let app: TestApp;
let acc: Account;
const deviceid = randomUUID();

beforeAll(async () => { app = await build(); acc = await createAccount(app); });
afterAll(async () => { await acc.remove(); await app.close(); });

const login = () => loginDevice(app, { deviceid, userid: acc.userid, downloadid: acc.phoneDownloadid, applegoogleid: 'test-' + acc.userid.slice(0, 8), device: 'iPhone16,1' });

test('login, check, refresh, grace, logout', async () => {
  const a = await login();
  expect((await checkAccess(app, `Bearer ${a.accessToken}`)).userid).toBe(acc.userid);

  // a second login from the same device replaces that device's row
  const b = await login();
  const rows = await app.pg.writer.query('SELECT count(*)::int n FROM usertokens WHERE deviceid = $1', [deviceid]);
  expect(rows.rows[0].n).toBe(1);
  clearAuthCache();
  await expect(checkAccess(app, `Bearer ${a.accessToken}`)).rejects.toMatchObject({ code: 'LOGOUT' });

  // refresh rotates both values
  const r1 = await app.inject({ method: 'POST', url: '/phone/v3/auth/refresh', payload: { refreshToken: b.refreshToken } });
  expect(r1.statusCode).toBe(200);
  expect(r1.json().refreshToken).not.toBe(b.refreshToken);

  // a retry with the old value works (a lost reply) and gives a fresh pair
  const r2 = await app.inject({ method: 'POST', url: '/phone/v3/auth/refresh', payload: { refreshToken: b.refreshToken } });
  expect(r2.statusCode).toBe(200);
  const n2 = r2.json();

  // a day later it still works (the app may not be opened for a while after a reload), and each retry moves the window on
  await app.pg.writer.query('UPDATE usertokens SET prev_changed_date = prev_changed_date - 86400 WHERE deviceid = $1', [deviceid]);
  const day = await app.inject({ method: 'POST', url: '/phone/v3/auth/refresh', payload: { refreshToken: b.refreshToken } });
  expect(day.statusCode).toBe(200);
  const stamp = (await app.pg.writer.query('SELECT prev_changed_date FROM usertokens WHERE deviceid = $1', [deviceid])).rows[0].prev_changed_date;
  expect(Number(stamp)).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
  const n3 = day.json();

  // after the grace window (30 days) the previous value is refused
  await app.pg.writer.query('UPDATE usertokens SET prev_changed_date = prev_changed_date - $2 WHERE deviceid = $1', [deviceid, 31 * 86400]);
  const r3 = await app.inject({ method: 'POST', url: '/phone/v3/auth/refresh', payload: { refreshToken: b.refreshToken } });
  expect(r3.statusCode).toBe(401);
  expect(r3.json().code).toBe('LOGOUT');

  // logout revokes this device only; the token is then LOGOUT
  const lo = await app.inject({ method: 'POST', url: '/phone/v3/auth/logout', headers: bearer(n3.accessToken), payload: { refreshToken: n3.refreshToken } });
  expect(lo.json()).toEqual({ revoked: 1 });
  clearAuthCache();
  const after = await app.inject({ method: 'POST', url: '/phone/v3/auth/logout', headers: bearer(n3.accessToken), payload: {} });
  expect(after.json().code).toBe('LOGOUT');
});

test('format, expiry and garbage', async () => {
  await expect(checkAccess(app, 'Token abc')).rejects.toMatchObject({ code: 'INVALID_TOKEN_FORMAT' });
  await expect(checkAccess(app, 'Bearer not.a.jwt')).rejects.toMatchObject({ code: 'LOGOUT' });

  const t = await login();
  const { access_token } = app.jwt.decode(t.accessToken) as { access_token: string };
  const expired = app.jwt.sign({ access_token }, { expiresIn: '-10s' });
  await expect(checkAccess(app, `Bearer ${expired}`)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  const unknown = app.jwt.sign({ access_token: 'f'.repeat(64) }, { expiresIn: '-10s' });
  await expect(checkAccess(app, `Bearer ${unknown}`)).rejects.toMatchObject({ code: 'LOGOUT' });
});

test('a short grace (REFRESH_GRACE_SECONDS=120, as in local testing) is honoured: a retry inside it works, one after it is refused', async () => {
  const saved = process.env.REFRESH_GRACE_SECONDS;
  process.env.REFRESH_GRACE_SECONDS = '120';
  try {
    const dev = randomUUID();
    const t = await loginDevice(app, { deviceid: dev, userid: acc.userid, downloadid: acc.phoneDownloadid, applegoogleid: 'test-' + acc.userid.slice(0, 8), device: 'iPhone16,1' });
    const post = (refreshToken: string) => app.inject({ method: 'POST', url: '/phone/v3/auth/refresh', payload: { refreshToken } });
    expect((await post(t.refreshToken)).statusCode).toBe(200);
    expect((await post(t.refreshToken)).statusCode).toBe(200); // a retry inside the 120 seconds
    await app.pg.writer.query('UPDATE usertokens SET prev_changed_date = prev_changed_date - 200 WHERE deviceid = $1', [dev]);
    const late = await post(t.refreshToken);
    expect(late.statusCode).toBe(401);
    expect(late.json().code).toBe('LOGOUT');
  } finally {
    if (saved === undefined) delete process.env.REFRESH_GRACE_SECONDS;
    else process.env.REFRESH_GRACE_SECONDS = saved;
    await app.pg.writer.query('DELETE FROM usertokens WHERE deviceid IN (SELECT deviceid FROM usertokens WHERE userid = $1 AND deviceid <> $2)', [acc.userid, deviceid]);
  }
});
