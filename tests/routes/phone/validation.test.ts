import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../../helpers/app.js';
import { bearer } from '../../helpers/fixtures.js';

let app: TestApp;
let acc: Account;
beforeAll(async () => { app = await build(); acc = await createAccount(app); });
afterAll(async () => { await acc.remove(); await app.close(); });

const post = (url: string, payload: unknown, token?: string) =>
  app.inject({ method: 'POST', url, headers: token ? bearer(token) : {}, payload: payload as object });

test('a body that does not match its schema is a 400 BAD_REQUEST that names the field', async () => {
  const cases: [string, unknown, string | undefined, string][] = [
    ['/phone/v3/auth/refresh', {}, undefined, 'refreshToken'],
    ['/phone/v3/auth/refresh', { refreshToken: '' }, undefined, 'refreshToken'],
    ['/phone/v3/auth/logout', { refreshToken: '' }, acc.phoneToken, 'refreshToken'],
    ['/wearable/v3/activities/batch', {}, acc.watchToken, 'activities'],
    ['/phone/v3/sync', { up: [1] }, acc.phoneToken, 'up'],
    ['/phone/v3/auth/dev-login', { deviceid: 'nope' }, undefined, 'deviceid'],
    ['/wearable/v3/auth/refresh', {}, undefined, 'refreshToken'],
  ];
  for (const [url, body, token, field] of cases) {
    const res = await post(url, body, token);
    expect(res.statusCode, `${url} ${JSON.stringify(body)}`).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.json().message).toContain(field);
  }
});

test('a lone value is never wrapped into a list (Fastify\'s default coercion would)', async () => {
  const res = await post('/wearable/v3/activities/batch', { activities: 'x' }, acc.watchToken);
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('BAD_REQUEST');
});

test('the batch rules stay the service\'s: an empty list or more than 20 is BAD_BATCH', async () => {
  expect((await post('/wearable/v3/activities/batch', { activities: [] }, acc.watchToken)).json().code).toBe('BAD_BATCH');
});

test('extra fields are tolerated (an app a version ahead must not break)', async () => {
  const res = await post('/phone/v3/auth/refresh', { refreshToken: 'x'.repeat(64), future: true });
  expect(res.statusCode).toBe(401);          // it got past the schema and failed on the token
  expect(res.json().code).toBe('LOGOUT');
});

test('auth is checked before the body: a bad token with a bad body is the token error', async () => {
  const res = await post('/wearable/v3/activities/batch', {}, 'a.b.c');
  expect(res.json().code).toBe('LOGOUT');
});
