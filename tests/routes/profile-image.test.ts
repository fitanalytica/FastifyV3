import { test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';

// S3 is a fake here (an in-memory bucket, keyed by bucket and key). The signing is real and offline.
const fake = vi.hoisted(() => ({ files: new Map<string, { size: number; contentType: string }>(), failDelete: false }));
vi.mock('../../src/services/media/s3Ops.js', () => ({
  headObject: async (key: string, bucket = 'media') => fake.files.get(`${bucket}/${key}`) ?? null,
  deleteObjects: async (keys: string[], bucket = 'media') => { if (fake.failDelete) throw new Error('S3 is down'); keys.forEach((k) => fake.files.delete(`${bucket}/${k}`)); },
  deleteFolder: async () => 0,
}));

let app: TestApp;
let me: Account, other: Account, noProfile: Account;

beforeAll(async () => {
  app = await build();
  [me, other, noProfile] = [await createAccount(app), await createAccount(app), await createAccount(app)];
  for (const [acc, name] of [[me, 'Me'], [other, 'Other']] as const) {
    await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, hideprofile, dateregistered) VALUES ($1, $2, false, 1700000000)`, [acc.userid, name]);
  }
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[me.userid, other.userid]]);
  for (const a of [me, other, noProfile]) await a.remove();
  await app.close();
});
beforeEach(async () => {
  fake.files.clear(); fake.failDelete = false;
  await app.pg.writer.query(`UPDATE userinfo SET profilepic = NULL, profilebg = NULL, hideprofile = false WHERE userid = ANY($1)`, [[me.userid, other.userid]]);
});

const call = (method: 'POST' | 'DELETE' | 'GET', url: string, token = me.phoneToken, payload?: object) =>
  app.inject({ method, url: `/phone/v3${url}`, headers: bearer(token), ...(payload ? { payload } : {}) });
const presign = (body: object, token = me.phoneToken) => call('POST', '/profile/image/presign', token, body);
const commit = (body: object, token = me.phoneToken) => call('POST', '/profile/image/commit', token, body);
const column = async (c: 'profilepic' | 'profilebg', acc = me) => (await app.pg.writer.query(`SELECT ${c} AS v FROM userinfo WHERE userid = $1`, [acc.userid])).rows[0].v as string | null;
const upload = (value: string, size = 1000, contentType = 'image/webp') => fake.files.set(`profile/${value}`, { size, contentType });
const name = (ext = 'webp') => `${randomUUID()}.${ext}`;

// ---------------------------------------------------------------------------------------------------------------------------------- presign

test('presign: a name the server makes, in the profile bucket, signed for this type and length', async () => {
  const res = await presign({ kind: 'pic', contentType: 'image/webp', bytes: 50_000 });
  expect(res.statusCode).toBe(200);
  const { value, url, headers } = res.json();
  expect(value).toMatch(/^[0-9a-f-]{36}\.webp$/);
  expect(headers).toEqual({ 'Content-Type': 'image/webp' });
  const u = new URL(url);
  expect(u.pathname).toBe(`/fitpy/${value}`);                      // the profile bucket, no folder
  const signed = (u.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
  expect(signed).toEqual(expect.arrayContaining(['content-type', 'content-length']));
});

test('presign: the type and size are checked, per kind', async () => {
  for (const bad of [
    { kind: 'pic', contentType: 'video/mp4', bytes: 10 },
    { kind: 'pic', contentType: 'image/webp', bytes: 2 * 1024 * 1024 },   // a picture is at most 1 MB
    { kind: 'bg', contentType: 'image/webp', bytes: 4 * 1024 * 1024 },    // a cover at most 3 MB
  ]) expect((await presign(bad)).statusCode, JSON.stringify(bad)).toBe(400);
  expect((await presign({ kind: 'bg', contentType: 'image/webp', bytes: 2 * 1024 * 1024 })).statusCode).toBe(200);
  expect((await presign({ kind: 'avatar', contentType: 'image/webp', bytes: 10 })).statusCode).toBe(400);
});

test('presign: needs a profile, and a phone token', async () => {
  expect((await presign({ kind: 'pic', contentType: 'image/webp', bytes: 10 }, noProfile.phoneToken)).statusCode).toBe(404);
  expect((await presign({ kind: 'pic', contentType: 'image/webp', bytes: 10 }, me.watchToken)).statusCode).toBe(403);
});

// ---------------------------------------------------------------------------------------------------------------------------------- commit

test('commit: the file is there, so it becomes the picture; the cover is separate', async () => {
  const [pic, bg] = [name(), name()]; upload(pic); upload(bg);
  expect((await commit({ kind: 'pic', value: pic })).json()).toEqual({ value: pic });
  expect(await column('profilepic')).toBe(pic);
  expect(await column('profilebg')).toBeNull();
  await commit({ kind: 'bg', value: bg });
  expect(await column('profilebg')).toBe(bg);
  expect(await column('profilepic')).toBe(pic);
});

test('commit: a new picture replaces the old one and the old file is deleted', async () => {
  const [first, second] = [name(), name()]; upload(first); upload(second);
  await commit({ kind: 'pic', value: first });
  await commit({ kind: 'pic', value: second });
  expect(await column('profilepic')).toBe(second);
  expect(fake.files.has(`profile/${first}`)).toBe(false);
  expect(fake.files.has(`profile/${second}`)).toBe(true);
});

test('commit: a repeat (the answer was lost) changes nothing and deletes nothing', async () => {
  const v = name(); upload(v);
  await commit({ kind: 'pic', value: v });
  expect((await commit({ kind: 'pic', value: v })).statusCode).toBe(200);
  expect(fake.files.has(`profile/${v}`)).toBe(true);
  expect(await column('profilepic')).toBe(v);
});

test('commit: a file that was never uploaded is refused', async () => {
  const res = await commit({ kind: 'pic', value: name() });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('BAD_MEDIA');
  expect(await column('profilepic')).toBeNull();
});

test('commit: too big or the wrong type is refused and the file removed', async () => {
  const [big, wrong] = [name(), name()];
  upload(big, 2 * 1024 * 1024); upload(wrong, 100, 'video/mp4');
  expect((await commit({ kind: 'pic', value: big })).statusCode).toBe(400);
  expect((await commit({ kind: 'pic', value: wrong })).statusCode).toBe(400);
  expect(fake.files.size).toBe(0);
  expect(await column('profilepic')).toBeNull();
});

test('commit: needs a profile, and a name the server made', async () => {
  const v = name(); upload(v);
  expect((await commit({ kind: 'pic', value: v }, noProfile.phoneToken)).statusCode).toBe(404);
  for (const value of ['pic.webp', '../x.webp', `${randomUUID()}.png`]) expect((await commit({ kind: 'pic', value })).statusCode, value).toBe(400);
});

test('commit: when S3 is down the new picture is still set (the old file is an orphan)', async () => {
  const [first, second] = [name(), name()]; upload(first); upload(second);
  await commit({ kind: 'pic', value: first });
  fake.failDelete = true;
  expect((await commit({ kind: 'pic', value: second })).statusCode).toBe(200);
  expect(await column('profilepic')).toBe(second);
});

// ---------------------------------------------------------------------------------------------------------------------------------- reset

test('reset: back to no picture, the file is deleted; the cover is untouched', async () => {
  const [pic, bg] = [name(), name()]; upload(pic); upload(bg);
  await commit({ kind: 'pic', value: pic }); await commit({ kind: 'bg', value: bg });
  expect((await call('DELETE', '/profile/image/pic')).statusCode).toBe(204);
  expect(await column('profilepic')).toBeNull();
  expect(fake.files.has(`profile/${pic}`)).toBe(false);
  expect(await column('profilebg')).toBe(bg);
  expect(fake.files.has(`profile/${bg}`)).toBe(true);
});

test('reset: a repeat, or with none set, is still 204; with no profile it is 404', async () => {
  expect((await call('DELETE', '/profile/image/bg')).statusCode).toBe(204);
  expect((await call('DELETE', '/profile/image/bg')).statusCode).toBe(204);
  expect((await call('DELETE', '/profile/image/bg', noProfile.phoneToken)).statusCode).toBe(404);
  expect((await call('DELETE', '/profile/image/avatar')).statusCode).toBe(400);
});

// ---------------------------------------------------------------------------------------------------------------------------------- reading

test('reading: a signed-in user is redirected to the signed address of the current picture, and the token may be X-Access-Token', async () => {
  const v = name(); upload(v); await commit({ kind: 'pic', value: v });
  const res = await call('GET', `/profilepic/${me.userid}/${v}`, other.phoneToken);
  expect(res.statusCode).toBe(302);
  const u = new URL(res.headers.location as string);
  expect(u.pathname).toBe(`/fitpy/${v}`);
  expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
  expect((await app.inject({ url: `/phone/v3/profilepic/${me.userid}/${v}`, headers: { 'x-access-token': other.phoneToken } })).statusCode).toBe(302);
});

test('reading: the cover has its own address; a picture value does not open as a cover', async () => {
  const [pic, bg] = [name(), name()]; upload(pic); upload(bg);
  await commit({ kind: 'pic', value: pic }); await commit({ kind: 'bg', value: bg });
  expect((await call('GET', `/profilebg/${me.userid}/${bg}`, other.phoneToken)).statusCode).toBe(302);
  expect((await call('GET', `/profilebg/${me.userid}/${pic}`, other.phoneToken)).statusCode).toBe(404);
});

test('reading: only what is set now: an old or invented name is a 404 (the route cannot read other files in the bucket)', async () => {
  const [old, now] = [name(), name()]; upload(old); upload(now);
  await commit({ kind: 'pic', value: old }); await commit({ kind: 'pic', value: now });
  expect((await call('GET', `/profilepic/${me.userid}/${old}`, other.phoneToken)).statusCode).toBe(404);
  expect((await call('GET', `/profilepic/${me.userid}/${name()}`, other.phoneToken)).statusCode).toBe(404);
  expect((await call('GET', `/profilepic/${randomUUID()}/${now}`, other.phoneToken)).statusCode).toBe(404);
});

test('reading: a hidden profile\'s picture is for its owner only', async () => {
  const v = name(); upload(v); await commit({ kind: 'pic', value: v });
  await app.pg.writer.query('UPDATE userinfo SET hideprofile = true WHERE userid = $1', [me.userid]);
  expect((await call('GET', `/profilepic/${me.userid}/${v}`, other.phoneToken)).statusCode).toBe(404);
  expect((await call('GET', `/profilepic/${me.userid}/${v}`, me.phoneToken)).statusCode).toBe(302);
});

test('reading: not with a watch token, and the name cannot leave the bucket', async () => {
  const v = name(); upload(v); await commit({ kind: 'pic', value: v });
  expect((await call('GET', `/profilepic/${me.userid}/${v}`, me.watchToken)).statusCode).toBe(403);
  expect((await call('GET', `/profilepic/${me.userid}/..%2Fx`, other.phoneToken)).statusCode).toBe(400);
});
