import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, type TestApp } from '../../helpers/app.js';
import { bearer } from '../../helpers/fixtures.js';

let app: TestApp;
beforeAll(async () => { app = await build(); });
afterAll(async () => { await app.close(); });

test('dev-login signs in a usable token (and /me says who it is)', async () => {
  const deviceid = randomUUID();
  const res = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid } });
  expect(res.statusCode).toBe(200);
  const { accessToken, userid } = res.json();
  const me = await app.inject({ url: '/phone/v3/me', headers: bearer(accessToken) });
  expect(me.json()).toMatchObject({ userid, deviceType: 'phone' });
  expect((await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: {} })).statusCode).toBe(400);
  await app.pg.writer.query('DELETE FROM usertokens WHERE deviceid = $1', [deviceid]);
});

test('dev-login can make a watch device: device_type watch and platform watchos / wearos, and a watch token', async () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ watch: true }, 'watch', 'watchos'], [{ watch: true, platform: 'android' }, 'watch', 'wearos'],
    [{}, 'phone', 'ios'], [{ platform: 'android' }, 'phone', 'android'],
  ];
  for (const [extra, type, platform] of cases) {
    const deviceid = randomUUID();
    const res = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid, ...extra } });
    const { downloadid, accessToken } = res.json();
    const row = await app.pg.writer.query('SELECT device_type::text AS t, platform::text AS p FROM downloads WHERE downloadid = $1', [downloadid]);
    expect(row.rows[0]).toEqual({ t: type, p: platform });
    const path = type === 'watch' ? '/wearable/v3/me' : '/phone/v3/me';
    expect((await app.inject({ url: path, headers: bearer(accessToken) })).json().deviceType).toBe(type);
    await app.pg.writer.query('DELETE FROM usertokens WHERE deviceid = $1', [deviceid]);
    await app.pg.writer.query('DELETE FROM downloads WHERE downloadid = $1', [downloadid]);
  }
});

test('provider: signs in as the user mapped in the env, and falls back to the dev user when nothing is mapped', async () => {
  const { createAccount } = await import('../../helpers/app.js');
  const acc = await createAccount(app);
  const keep = process.env.DEV_USER_APPLE;
  const ids: string[] = [];
  try {
    process.env.DEV_USER_APPLE = acc.userid;
    const a = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), provider: 'apple' } });
    expect(a.json().userid).toBe(acc.userid);
    ids.push(a.json().downloadid);
    expect((await app.inject({ url: '/phone/v3/me', headers: bearer(a.json().accessToken) })).json().userid).toBe(acc.userid);

    // the same install (downloadid) signs in again as the same user, and no new downloads row is made
    const again = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), downloadid: a.json().downloadid, provider: 'apple' } });
    expect(again.json().downloadid).toBe(a.json().downloadid);

    // a mapped user that is not in the database falls back to the dev user; no mapping at all too
    process.env.DEV_USER_APPLE = randomUUID();
    const missing = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), provider: 'apple' } });
    ids.push(missing.json().downloadid);
    delete process.env.DEV_USER_APPLE;
    const none = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), provider: 'apple' } });
    ids.push(none.json().downloadid);
    expect(missing.json().userid).toBe(none.json().userid);
    expect(missing.json().userid).not.toBe(acc.userid);

    expect((await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), provider: 'facebook' } })).statusCode).toBe(400);
  } finally {
    if (keep === undefined) delete process.env.DEV_USER_APPLE; else process.env.DEV_USER_APPLE = keep;
    await app.pg.writer.query('DELETE FROM usertokens WHERE downloadid = ANY($1)', [ids]);
    await app.pg.writer.query('DELETE FROM downloads WHERE downloadid = ANY($1)', [ids]);
    await acc.remove();
  }
});

test('userid: signs in as exactly that user, wins over the provider mapping, and an unknown user is a clear 400', async () => {
  const { createAccount } = await import('../../helpers/app.js');
  const acc = await createAccount(app);
  const other = await createAccount(app);
  const keep = process.env.DEV_USER_APPLE;
  const ids: string[] = [];
  try {
    process.env.DEV_USER_APPLE = other.userid;            // the provider says `other` ...
    const a = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), provider: 'apple', userid: acc.userid } });
    expect(a.statusCode).toBe(200);
    expect(a.json().userid).toBe(acc.userid);              // ... but the userid asked for wins
    ids.push(a.json().downloadid);
    expect((await app.inject({ url: '/phone/v3/me', headers: bearer(a.json().accessToken) })).json().userid).toBe(acc.userid);

    const unknown = await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), userid: randomUUID() } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('not in the local database') });

    expect((await app.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID(), userid: 'nope' } })).statusCode).toBe(400);
  } finally {
    if (keep === undefined) delete process.env.DEV_USER_APPLE; else process.env.DEV_USER_APPLE = keep;
    await app.pg.writer.query('DELETE FROM usertokens WHERE downloadid = ANY($1)', [ids]);
    await app.pg.writer.query('DELETE FROM downloads WHERE downloadid = ANY($1)', [ids]);
    await acc.remove();
    await other.remove();
  }
});

test('the route exists only with DEV_LOGIN=true', async () => {
  const keep = process.env.DEV_LOGIN;
  process.env.DEV_LOGIN = 'false';
  const off = await build();
  const res = await off.inject({ method: 'POST', url: '/phone/v3/auth/dev-login', payload: { deviceid: randomUUID() } });
  expect(res.statusCode).toBe(404);
  await off.close();
  process.env.DEV_LOGIN = keep;
});
