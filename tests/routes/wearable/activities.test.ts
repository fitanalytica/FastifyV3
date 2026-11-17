import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { PHONE_BATCH, WEARABLE_BATCH, activity, activityRow, bearer } from '../../helpers/fixtures.js';

let app: TestApp;
let acc: Account;
beforeAll(async () => { app = await build(); acc = await createAccount(app); });
afterAll(async () => { await acc.remove(); await app.close(); });

const post = (url: string, token: string, activities: unknown[]) =>
  app.inject({ method: 'POST', url, headers: bearer(token), payload: { activities } });

test('a watch upload is tosend 2, and the phone repeat acknowledges it (LEAST)', async () => {
  const a = activity(acc.watchDownloadid, { iswatch: true });
  const w = await post(WEARABLE_BATCH, acc.watchToken, [a]);
  expect(w.json().results[0]).toEqual({ activityid: a.activityid, status: 'created', tosend: 2 });
  expect((await activityRow(app, a.activityid)).iswatch).toBe(true);

  const p = await post(PHONE_BATCH, acc.phoneToken, [a]);
  expect(p.json().results[0]).toEqual({ activityid: a.activityid, status: 'exists', tosend: 1 });
  expect((await activityRow(app, a.activityid)).tosend).toBe(1);

  // the watch repeating later does not move it back to 2
  await post(WEARABLE_BATCH, acc.watchToken, [a]);
  expect((await activityRow(app, a.activityid)).tosend).toBe(1);
});

test('the watch group has no logout and no dev-login', async () => {
  for (const url of ['/wearable/v3/auth/logout', '/wearable/v3/auth/dev-login']) {
    const res = await app.inject({ method: 'POST', url, headers: bearer(acc.watchToken), payload: {} });
    expect(res.json().code).toBe('NOT_FOUND');
  }
});
