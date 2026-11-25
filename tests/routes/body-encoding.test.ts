import { test, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';

// A large body as gzip in base64 text (src/hooks/bodyEncoding.ts): what the phone sends, because binary did not arrive intact on Android.
let app: TestApp;
let a: Account;
const ids = Array.from({ length: 80 }, (_, i) => `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`);
const json = JSON.stringify({ up: { feedScrub: { ids }, device: {} } });
const send = (payload: string | Buffer, headers: Record<string, string>) => app.inject({ method: 'POST', url: '/phone/v3/sync', headers: { ...bearer(a.phoneToken), 'content-type': 'application/json', ...headers }, payload });

beforeAll(async () => {
  app = await build();
  a = await createAccount(app);
});
afterAll(async () => {
  await a.remove();
  await app.close();
});

test('a body that is gzip in base64 text is unpacked and handled like a plain one', async () => {
  const text = gzipSync(json).toString('base64');
  expect(text.length).toBeLessThan(json.length);
  const res = await send(text, { 'x-body-encoding': 'gzip-base64' });
  expect(res.statusCode).toBe(200);
  expect(res.json().results.feedScrub).toEqual({ ok: true });
  expect(res.json().down.feedScrub.gone).toHaveLength(80);
});

test('the plain body and the binary gzip body still work, and a body that is not gzip in base64 is refused', async () => {
  expect((await send(json, {})).statusCode).toBe(200);
  expect((await send(gzipSync(json), { 'content-encoding': 'gzip' })).statusCode).toBe(200);
  const bad = await send('this is not base64 gzip', { 'x-body-encoding': 'gzip-base64' });
  expect(bad.statusCode).toBe(400);
  const notGzip = await send(Buffer.from(json).toString('base64'), { 'x-body-encoding': 'gzip-base64' });
  expect(notGzip.statusCode).toBe(400);
});

test('a body that unpacks to far more than it should is refused, not unpacked into memory', async () => {
  const bomb = gzipSync(Buffer.alloc(9 * 1024 * 1024, 32)).toString('base64');
  expect((await send(bomb, { 'x-body-encoding': 'gzip-base64' })).statusCode).toBe(400);
});
