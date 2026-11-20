import { test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';
import { phoneBatch, phoneDelete } from '../helpers/viaSync.js';

// S3 is a fake here (an in-memory bucket): the tests check what the server decides, not what S3 does. The signing itself is real and offline.
const fake = vi.hoisted(() => ({ files: new Map<string, { size: number; contentType: string }>(), failDelete: false }));
vi.mock('../../src/services/media/s3Ops.js', () => ({
  headObject: async (key: string) => fake.files.get(key) ?? null,
  deleteObjects: async (keys: string[]) => { if (fake.failDelete) throw new Error('S3 is down'); keys.forEach((k) => fake.files.delete(k)); },
  deleteFolder: async (activityid: string) => {
    if (fake.failDelete) throw new Error('S3 is down');
    for (const k of [...fake.files.keys()]) if (k.startsWith(`${activityid}/`)) fake.files.delete(k);
    return 0;
  },
}));

let app: TestApp;
let owner: Account, other: Account;
let act: string;

beforeAll(async () => {
  app = await build();
  owner = await createAccount(app); other = await createAccount(app);
  const a = activity(owner.phoneDownloadid);
  act = a.activityid;
  await phoneBatch(app, owner.phoneToken, [a]);
});
afterAll(async () => { await owner.remove(); await other.remove(); await app.close(); });
beforeEach(async () => {
  fake.files.clear(); fake.failDelete = false;
  await app.pg.writer.query(`UPDATE activities SET media_v2 = '[]'::jsonb, media = NULL, tosend = 1 WHERE activityid = $1`, [act]);
});

const post = (url: string, body: unknown, token = owner.phoneToken) => app.inject({ method: 'POST', url: `/phone/v3/media/${url}`, headers: bearer(token), payload: body as object });
const presign = (body: object, id = act, token = owner.phoneToken) => post(`${id}/presign`, body, token);
const commit = (body: object, id = act, token = owner.phoneToken) => post(`${id}/commit`, body, token);
const remove = (value: string, id = act, token = owner.phoneToken) => app.inject({ method: 'DELETE', url: `/phone/v3/media/${id}/${value}`, headers: bearer(token) });
const list = async () => (await app.pg.writer.query('SELECT media_v2 FROM activities WHERE activityid = $1', [act])).rows[0].media_v2 as { value: string }[];
const upload = (value: string, size = 1000, contentType = 'image/webp', id = act) => fake.files.set(`${id}/${value}`, { size, contentType });
const name = (ext = 'webp') => `${randomUUID()}.${ext}`;

// ---------------------------------------------------------------------------------------------------------------------------------- presign

test('presign: a name the server makes, and an address signed for this exact type and length', async () => {
  const res = await presign({ role: 'photo', contentType: 'image/webp', bytes: 123456 });
  expect(res.statusCode).toBe(200);
  const { value, url, headers } = res.json();
  expect(value).toMatch(/^[0-9a-f-]{36}\.webp$/);
  expect(headers).toEqual({ 'Content-Type': 'image/webp' });
  const u = new URL(url);
  expect(u.pathname).toBe(`/activitees/${act}/${value}`);
  expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
  const signed = (u.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
  expect(signed).toContain('content-type');
  expect(signed).toContain('content-length');
});

test('presign: each file gets its own name; video is mp4, poster is an image', async () => {
  const a = (await presign({ role: 'photo', contentType: 'image/webp', bytes: 10 })).json().value;
  const b = (await presign({ role: 'photo', contentType: 'image/webp', bytes: 10 })).json().value;
  expect(a).not.toBe(b);
  expect((await presign({ role: 'video', contentType: 'video/mp4', bytes: 10_000_000 })).json().value).toMatch(/\.mp4$/);
  expect((await presign({ role: 'poster', contentType: 'image/webp', bytes: 10 })).json().value).toMatch(/\.webp$/);
});

test('presign: the type must suit the role, and the size must be within the cap', async () => {
  for (const bad of [
    { role: 'photo', contentType: 'video/mp4', bytes: 10 },
    { role: 'video', contentType: 'image/webp', bytes: 10 },
    { role: 'photo', contentType: 'text/html', bytes: 10 },
    { role: 'photo', contentType: 'image/webp', bytes: 6 * 1024 * 1024 },
    { role: 'poster', contentType: 'image/webp', bytes: 3 * 1024 * 1024 },
    { role: 'video', contentType: 'video/mp4', bytes: 41 * 1024 * 1024 },
  ]) {
    const res = await presign(bad);
    expect(res.statusCode, JSON.stringify(bad)).toBe(400);
  }
  expect((await presign({ role: 'photo', contentType: 'image/webp', bytes: 0 })).statusCode).toBe(400);
  expect((await presign({ role: 'gif', contentType: 'image/webp', bytes: 10 })).statusCode).toBe(400);
});

test('presign: only for your own activity that is not deleted', async () => {
  expect((await presign({ role: 'photo', contentType: 'image/webp', bytes: 10 }, act, other.phoneToken)).statusCode).toBe(404);
  expect((await presign({ role: 'photo', contentType: 'image/webp', bytes: 10 }, randomUUID())).statusCode).toBe(404);
  await app.pg.writer.query('UPDATE activities SET tosend = 0 WHERE activityid = $1', [act]);
  expect((await presign({ role: 'photo', contentType: 'image/webp', bytes: 10 })).statusCode).toBe(404);
});

test('a watch token cannot use the media routes', async () => {
  expect((await presign({ role: 'photo', contentType: 'image/webp', bytes: 10 }, act, owner.watchToken)).statusCode).toBe(403);
});

// ---------------------------------------------------------------------------------------------------------------------------------- commit

test('commit: the file is there, so it is added, and the whole list comes back', async () => {
  const v = name(); upload(v);
  const res = await commit({ value: v, type: 'photo', dimension: [800, 600] });
  expect(res.statusCode).toBe(200);
  expect(res.json().media_v2).toEqual([{ type: 'photo', value: v, dimension: [800, 600] }]);
  expect(await list()).toEqual([{ type: 'photo', value: v, dimension: [800, 600] }]);
});

test('commit: a repeat (the answer was lost) changes nothing and answers the same list', async () => {
  const v = name(); upload(v);
  const first = (await commit({ value: v, type: 'photo', dimension: [800, 600] })).json();
  const again = await commit({ value: v, type: 'photo', dimension: [800, 600] });
  expect(again.statusCode).toBe(200);
  expect(again.json()).toEqual(first);
  expect(await list()).toHaveLength(1);
});

test('commit: the blur placeholder is stored in the item as it was sent, and only 96 hex characters are accepted', async () => {
  const v = name(); upload(v);
  const blur = 'a1b2c3'.repeat(16);
  const res = await commit({ value: v, type: 'photo', dimension: [800, 600], blur });
  expect(res.statusCode).toBe(200);
  expect(res.json().media_v2[0]).toEqual({ type: 'photo', value: v, dimension: [800, 600], blur });
  for (const bad of ['short', 'A1B2C3'.repeat(16), 'g'.repeat(96), 'a'.repeat(97)]) {
    expect((await commit({ value: name(), type: 'photo', dimension: [1, 1], blur: bad })).statusCode, bad).toBe(400);
  }
});

test('commit: the list keeps its order, new items at the end', async () => {
  const [a, b] = [name(), name()]; upload(a); upload(b);
  await commit({ value: a, type: 'photo', dimension: [1, 1] });
  await commit({ value: b, type: 'photo', dimension: [2, 2] });
  expect((await list()).map((i) => i.value)).toEqual([a, b]);
});

test('commit: a video carries its poster and its length; both files are checked', async () => {
  const [v, p] = [name('mp4'), name()]; upload(v, 5000, 'video/mp4'); upload(p);
  const res = await commit({ value: v, type: 'video', dimension: [1280, 720], duration: 12.4, poster: p });
  expect(res.statusCode).toBe(200);
  expect(res.json().media_v2[0]).toEqual({ type: 'video', value: v, dimension: [1280, 720], duration: 12.4, poster: p });
});

test('commit: a video needs a poster, a photo has none', async () => {
  const [v, p, ph] = [name('mp4'), name(), name()]; upload(v, 5000, 'video/mp4'); upload(p); upload(ph);
  expect((await commit({ value: v, type: 'video', dimension: [1, 1] })).statusCode).toBe(400);
  expect((await commit({ value: ph, type: 'photo', dimension: [1, 1], poster: p })).statusCode).toBe(400);
  expect(await list()).toEqual([]);
});

test('commit: a file that was never uploaded is refused', async () => {
  const res = await commit({ value: name(), type: 'photo', dimension: [1, 1] });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('BAD_MEDIA');
  expect(await list()).toEqual([]);
});

test('commit: a file over the cap, or of the wrong type, is refused and removed from S3', async () => {
  const [big, wrong] = [name(), name()];
  upload(big, 6 * 1024 * 1024); upload(wrong, 100, 'video/mp4');
  expect((await commit({ value: big, type: 'photo', dimension: [1, 1] })).statusCode).toBe(400);
  expect((await commit({ value: wrong, type: 'photo', dimension: [1, 1] })).statusCode).toBe(400);
  expect(fake.files.has(`${act}/${big}`)).toBe(false);
  expect(fake.files.has(`${act}/${wrong}`)).toBe(false);
  expect(await list()).toEqual([]);
});

test('commit: not for another user\'s activity, and their files are not touched', async () => {
  const v = name(); upload(v);
  expect((await commit({ value: v, type: 'photo', dimension: [1, 1] }, act, other.phoneToken)).statusCode).toBe(404);
  expect(fake.files.has(`${act}/${v}`)).toBe(true);
  expect(await list()).toEqual([]);
});

test('commit: an activity may have at most 20 photos and videos; the 21st is refused and its file removed', async () => {
  for (let i = 0; i < 20; i++) { const v = name(); upload(v); expect((await commit({ value: v, type: 'photo', dimension: [1, 1] })).statusCode).toBe(200); }
  const extra = name(); upload(extra);
  const res = await commit({ value: extra, type: 'photo', dimension: [1, 1] });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('MEDIA_LIMIT');
  expect(fake.files.has(`${act}/${extra}`)).toBe(false);
  expect(await list()).toHaveLength(20);
});

test('commit: a name the server did not make is refused', async () => {
  for (const value of ['photo.webp', '../x.webp', `${randomUUID()}.exe`, `${randomUUID()}.png`]) {
    expect((await commit({ value, type: 'photo', dimension: [1, 1] })).statusCode, value).toBe(400);
  }
  expect((await commit({ value: name(), type: 'photo', dimension: [0, 5] })).statusCode).toBe(400);
});

// ---------------------------------------------------------------------------------------------------------------------------------- remove

test('remove: the item leaves the list and its file leaves S3', async () => {
  const [a, b] = [name(), name()]; upload(a); upload(b);
  await commit({ value: a, type: 'photo', dimension: [1, 1] }); await commit({ value: b, type: 'photo', dimension: [1, 1] });
  expect((await remove(a)).statusCode).toBe(204);
  expect((await list()).map((i) => i.value)).toEqual([b]);
  expect(fake.files.has(`${act}/${a}`)).toBe(false);
  expect(fake.files.has(`${act}/${b}`)).toBe(true);
});

test('remove: a video takes its poster with it', async () => {
  const [v, p] = [name('mp4'), name()]; upload(v, 5000, 'video/mp4'); upload(p);
  await commit({ value: v, type: 'video', dimension: [1, 1], duration: 5, poster: p });
  expect((await remove(v)).statusCode).toBe(204);
  expect(fake.files.size).toBe(0);
  expect(await list()).toEqual([]);
});

test('remove: an old row\'s photo is removed from its old names too', async () => {
  await app.pg.writer.query(`UPDATE activities SET media = '["old1.webp","old2.webp"]'::jsonb WHERE activityid = $1`, [act]);
  upload('old1.webp'); upload('old2.webp');
  expect((await remove('old1.webp')).statusCode).toBe(204);
  const r = await app.pg.writer.query('SELECT media FROM activities WHERE activityid = $1', [act]);
  expect(r.rows[0].media).toEqual(['old2.webp']);
  expect(fake.files.has(`${act}/old1.webp`)).toBe(false);
});

test('remove: a repeat, or a value that is not in the list, is still 204 (and a stray file goes)', async () => {
  const v = name(); upload(v); // uploaded, never committed
  expect((await remove(v)).statusCode).toBe(204);
  expect(fake.files.has(`${act}/${v}`)).toBe(false);
  expect((await remove(v)).statusCode).toBe(204);
});

test('remove: not for another user\'s activity', async () => {
  const v = name(); upload(v);
  await commit({ value: v, type: 'photo', dimension: [1, 1] });
  expect((await remove(v, act, other.phoneToken)).statusCode).toBe(404);
  expect(await list()).toHaveLength(1);
  expect(fake.files.has(`${act}/${v}`)).toBe(true);
});

test('remove: when S3 is down the list is still changed (an orphan file, never a broken activity)', async () => {
  const v = name(); upload(v);
  await commit({ value: v, type: 'photo', dimension: [1, 1] });
  fake.failDelete = true;
  expect((await remove(v)).statusCode).toBe(204);
  expect(await list()).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------- delete the activity

test('deleting an activity deletes all its files in S3, and still succeeds when S3 is down', async () => {
  const v = name(); upload(v); upload('old.webp'); upload('x.webp', 10, 'image/webp', randomUUID()); // another activity's file
  await commit({ value: v, type: 'photo', dimension: [1, 1] });
  expect((await phoneDelete(app, owner.phoneToken, act)).statusCode).toBe(204);
  expect([...fake.files.keys()].filter((k) => k.startsWith(`${act}/`))).toEqual([]);
  expect(fake.files.size).toBe(1); // the other activity's file is untouched

  upload('again.webp'); fake.failDelete = true;
  expect((await phoneDelete(app, owner.phoneToken, act)).statusCode).toBe(204); // a repeat with S3 down
  fake.failDelete = false;
  expect((await phoneDelete(app, owner.phoneToken, act)).statusCode).toBe(204); // a repeat tries again
  expect(fake.files.has(`${act}/again.webp`)).toBe(false);
});
