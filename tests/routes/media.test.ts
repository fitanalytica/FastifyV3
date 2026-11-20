import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';
import { phoneBatch, phoneDelete } from '../helpers/viaSync.js';

let app: TestApp;
let owner: Account, other: Account;
let shown: string, hiddenAct: string, deleted: string;

beforeAll(async () => {
  app = await build();
  owner = await createAccount(app); other = await createAccount(app);
  const mk = (extra: Record<string, unknown> = {}) => activity(owner.phoneDownloadid, extra);
  const [a, b, c] = [mk(), mk(), mk()];
  shown = a.activityid; hiddenAct = b.activityid; deleted = c.activityid;
  await phoneBatch(app, owner.phoneToken, [a, b, c]);
  await phoneDelete(app, owner.phoneToken, deleted);
  // the owner's profile is shown: userinfo with hideprofile = false
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, hideprofile, dateregistered) VALUES ($1, 'Owner', false, 1700000000)`, [owner.userid]);
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [owner.userid]);
  await owner.remove(); await other.remove(); await app.close();
});

const get = (act: string, value: string, token = other.phoneToken) => app.inject({ url: `/phone/v3/media/${act}/${value}`, headers: bearer(token) });
const setHidden = (hidden: boolean) => app.pg.writer.query('UPDATE userinfo SET hideprofile = $2 WHERE userid = $1', [owner.userid, hidden]);

test('a signed-in user is redirected to a short-lived signed S3 address of exactly that file', async () => {
  const res = await get(shown, 'abc123.webp');
  expect(res.statusCode).toBe(302);
  const url = new URL(res.headers.location as string);
  expect(url.origin).toBe('http://localhost:9000');
  expect(url.pathname).toBe(`/activitees/${shown}/abc123.webp`);          // path style, the bucket from the config, key = <activityid>/<value>
  expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  expect(res.headers['cache-control']).toBe('private, max-age=600');
});

test('the owner can read their own media even when their profile is hidden; others cannot', async () => {
  await setHidden(true);
  try {
    expect((await get(shown, 'a.webp', owner.phoneToken)).statusCode).toBe(302);
    expect((await get(shown, 'a.webp', other.phoneToken)).statusCode).toBe(404);
  } finally { await setHidden(false); }
});

test('a deleted or unknown activity is a 404', async () => {
  expect((await get(deleted, 'a.webp')).statusCode).toBe(404);
  expect((await get(randomUUID(), 'a.webp')).statusCode).toBe(404);
});

test('the file name cannot leave the activity folder', async () => {
  for (const bad of ['..%2Fsecret.webp', '.hidden', 'a%2Fb.webp']) {
    expect((await get(shown, bad)).statusCode, bad).toBe(400);
  }
  expect((await get(shown, 'x'.repeat(101))).statusCode).toBe(414); // Fastify's own limit on a path parameter
  expect((await get('not-a-uuid', 'a.webp')).statusCode).toBe(400);
});

test('the media is for the phone: a watch token is refused', async () => {
  expect((await get(shown, 'a.webp', owner.watchToken)).statusCode).toBe(403);
});

test('the token may come as X-Access-Token (the phone sends it so, so that S3 never sees an Authorization header on the redirect)', async () => {
  const res = await app.inject({ url: `/phone/v3/media/${shown}/a.webp`, headers: { 'x-access-token': other.phoneToken } });
  expect(res.statusCode).toBe(302);
  expect((await app.inject({ url: `/phone/v3/media/${shown}/a.webp`, headers: { 'x-access-token': 'nonsense' } })).statusCode).toBeGreaterThanOrEqual(400);
  expect((await app.inject({ url: `/phone/v3/media/${shown}/a.webp` })).statusCode).toBe(400);
});

test('the picture routes have a limit of their own, far above the general 100 a minute, counted per token', async () => {
  let refused = 0;
  for (let i = 0; i < 130; i++) {
    const res = await app.inject({ url: `/phone/v3/media/${shown}/a.webp`, headers: { 'x-access-token': other.phoneToken } });
    if (res.statusCode === 429) refused++;
  }
  expect(refused).toBe(0); // 130 in a minute: the general limit would have refused 30
  // another user is counted separately, so one busy client does not use up another's allowance
  expect((await app.inject({ url: `/phone/v3/media/${shown}/a.webp`, headers: { 'x-access-token': owner.phoneToken } })).statusCode).toBe(302);
  // and the general limit is still there for everything else
  let generalRefused = 0;
  for (let i = 0; i < 105; i++) {
    if ((await app.inject({ url: '/health' })).statusCode === 429) generalRefused++;
  }
  expect(generalRefused).toBeGreaterThan(0);
});
