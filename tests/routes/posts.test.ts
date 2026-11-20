import { test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';
import { phoneBatch } from '../helpers/viaSync.js';

// What a user shares from Home (docs/data/api.md section 12): the post, its photos and videos (through the media routes), the user's own list, and the feed.
// S3 is a fake (an in-memory bucket), as in media-upload.test.ts.
const fake = vi.hoisted(() => ({ files: new Map<string, { size: number; contentType: string }>() }));
vi.mock('../../src/services/media/s3Ops.js', () => ({
  headObject: async (key: string) => fake.files.get(key) ?? null,
  deleteObjects: async (keys: string[]) => { keys.forEach((k) => fake.files.delete(k)); },
  deleteFolder: async (id: string) => { for (const k of [...fake.files.keys()]) if (k.startsWith(`${id}/`)) fake.files.delete(k); return 0; },
}));

let app: TestApp;
let a: Account, b: Account, hidden: Account;
const T = 1950000000; // far enough ahead that these are the newest in a test database

beforeAll(async () => {
  app = await build();
  [a, b, hidden] = [await createAccount(app), await createAccount(app), await createAccount(app)];
  for (const [acc, hide] of [[a, false], [b, false], [hidden, true]] as const) {
    await app.pg.writer.query(
      `INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered) VALUES ($1, 'Pat', 'Test', 68, 0, $2, 'Pune', 'MH', 'IN', 1700000000)`,
      [acc.userid, hide],
    );
  }
});
afterAll(async () => {
  for (const x of [a, b, hidden]) await x.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[a.userid, b.userid, hidden.userid]]);
  await app.close();
});
beforeEach(() => fake.files.clear());

const put = (id: string, body: object, token = a.phoneToken) => app.inject({ method: 'PUT', url: `/phone/v3/posts/${id}`, headers: bearer(token), payload: body as object });
const del = (id: string, token = a.phoneToken) => app.inject({ method: 'DELETE', url: `/phone/v3/posts/${id}`, headers: bearer(token) });
const own = async (qs = '', token = a.phoneToken) => (await app.inject({ url: `/phone/v3/posts${qs}`, headers: bearer(token) })).json() as { posts: { postid: string; posted_at: number; content: Record<string, unknown>; media_v2: unknown[] }[]; next: string | null };
const feed = async (token = b.phoneToken) => (await app.inject({ url: '/phone/v3/feed', headers: bearer(token) })).json().posts as { kind: string; author: { userid: string }; post?: { postid: string; content: Record<string, unknown> }; activity?: { activityid: string } }[];
const row = async (id: string) => (await app.pg.writer.query('SELECT * FROM posts WHERE postid = $1', [id])).rows[0];
const withText = (extra: object = {}) => ({ v: 1, title: 'Morning', ...extra });
const upload = (id: string, value: string) => fake.files.set(`${id}/${value}`, { size: 1000, contentType: 'image/webp' });
const name = () => `${randomUUID()}.webp`;
const commit = (id: string, value: string, token = a.phoneToken) => app.inject({ method: 'POST', url: `/phone/v3/media/${id}/commit`, headers: bearer(token), payload: { value, type: 'photo', dimension: [800, 600] } });

test('a post with text: made, and a repeat of the same PUT changes nothing but what it says', async () => {
  const id = randomUUID();
  const first = await put(id, { posted_at: T, content: withText() });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ status: 'created', media_v2: [] });
  const again = await put(id, { posted_at: T + 999, content: withText({ title: 'Evening', description: 'A long one' }) });
  expect(again.json().status).toBe('exists');
  const r = await row(id);
  expect(r.posted_at).toBe(T); // the time it was made is not changed by an edit
  expect(r.content).toEqual({ v: 1, title: 'Evening', description: 'A long one' });
  expect(r.userid).toBe(a.userid);
});

test('a post needs something to show: media coming, a title or a description; a template alone is not enough', async () => {
  const id = randomUUID();
  const tmpl = { v: 1, template: 'steps', steps: 5200, dtgraph: 1760000000 };
  expect((await put(id, { posted_at: T, content: tmpl })).statusCode).toBe(400);
  expect((await put(id, { posted_at: T, content: { ...tmpl, title: '   ' } })).json().code).toBe('BAD_POST');
  expect((await put(id, { posted_at: T, content: tmpl, media: 0 })).statusCode).toBe(400);
  expect((await put(id, { posted_at: T, content: tmpl, media: 2 })).statusCode).toBe(200); // media is coming: no text needed
  expect((await put(randomUUID(), { posted_at: T, content: { v: 1, description: 'Only words' } })).statusCode).toBe(200); // text only, no template
});

test('a template carries the numbers it shows', async () => {
  const body = (content: object) => ({ posted_at: T, content: { v: 1, title: 'x', ...content } });
  expect((await put(randomUUID(), body({ template: 'steps' }))).json().code).toBe('BAD_POST');
  expect((await put(randomUUID(), body({ template: 'distance', steps: 10 }))).json().code).toBe('BAD_POST');
  expect((await put(randomUUID(), body({ template: 'steps_distance', steps: 10 }))).json().code).toBe('BAD_POST');
  expect((await put(randomUUID(), body({ template: 'steps_distance', steps: 10, distance: 800 }))).statusCode).toBe(200);
  expect((await put(randomUUID(), body({ template: 'distance', distance: 800 }))).statusCode).toBe(200);
});

test('the shape is checked: an unknown template, an unknown field, too long, a wrong version, a missing time', async () => {
  for (const content of [
    { v: 1, title: 'x', template: 'swim' },
    { v: 2, title: 'x' },
    { v: 1, title: 'x'.repeat(121) },
    { v: 1, description: 'x'.repeat(2001) },
    { v: 1, title: 'x', steps: -1 },
  ]) expect((await put(randomUUID(), { posted_at: T, content })).statusCode, JSON.stringify(content)).toBe(400);
  expect((await put(randomUUID(), { content: withText() })).statusCode).toBe(400);
  expect((await put('not-a-uuid', { posted_at: T, content: withText() })).statusCode).toBe(400);
});

test('another user\'s post id is 404, and nobody signed in is refused', async () => {
  const id = randomUUID();
  await put(id, { posted_at: T, content: withText() });
  expect((await put(id, { posted_at: T, content: withText({ title: 'mine now' }) }, b.phoneToken)).statusCode).toBe(404);
  expect((await row(id)).content.title).toBe('Morning');
  expect((await del(id, b.phoneToken)).statusCode).toBe(404);
  expect((await app.inject({ method: 'PUT', url: `/phone/v3/posts/${id}`, payload: { posted_at: T, content: withText() } })).json().code).toBe('INVALID_TOKEN_FORMAT');
});

test('delete: a marker stays (what it said and its media go), the files go, a repeat is fine, a late PUT answers deleted, an unknown id is 404', async () => {
  const id = randomUUID();
  await put(id, { posted_at: T, content: withText(), media: 1 });
  const v = name();
  upload(id, v);
  expect((await commit(id, v)).statusCode).toBe(200);
  expect((await del(id)).statusCode).toBe(204);
  const r = await row(id);
  expect(r).toMatchObject({ tosend: 0, content: {}, media_v2: [] });
  expect(fake.files.has(`${id}/${v}`)).toBe(false);
  expect((await del(id)).statusCode).toBe(204);
  const late = await put(id, { posted_at: T, content: withText({ title: 'back' }) });
  expect(late.json().status).toBe('deleted');
  expect((await row(id)).content).toEqual({});
  expect((await del(randomUUID())).statusCode).toBe(404);
});

test('photos and videos go through the media routes with the post id: commit adds them to the post, remove takes them out, 20 at most', async () => {
  const id = randomUUID();
  await put(id, { posted_at: T, content: withText() });
  const v = name();
  upload(id, v);
  const c = await commit(id, v);
  expect(c.statusCode).toBe(200);
  expect(c.json().media_v2).toEqual([{ type: 'photo', value: v, dimension: [800, 600] }]);
  expect((await row(id)).media_v2).toHaveLength(1);
  const rm = await app.inject({ method: 'DELETE', url: `/phone/v3/media/${id}/${v}`, headers: bearer(a.phoneToken) });
  expect(rm.statusCode).toBe(204);
  expect((await row(id)).media_v2).toEqual([]);
  expect(fake.files.has(`${id}/${v}`)).toBe(false);
  for (let i = 0; i < 20; i++) { const x = name(); upload(id, x); expect((await commit(id, x)).statusCode).toBe(200); }
  const extra = name();
  upload(id, extra);
  const over = await commit(id, extra);
  expect(over.statusCode).toBe(409);
  expect(over.json().code).toBe('MEDIA_LIMIT');
  expect(fake.files.has(`${id}/${extra}`)).toBe(false);
  // another user cannot add to it
  const mine = name();
  upload(id, mine);
  expect((await commit(id, mine, b.phoneToken)).statusCode).toBe(404);
});

test('presign works for a post, and the file is read through the media route: the owner always, others unless the owner hides their profile', async () => {
  const id = randomUUID();
  await put(id, { posted_at: T, content: withText() });
  const p = await app.inject({ method: 'POST', url: `/phone/v3/media/${id}/presign`, headers: bearer(a.phoneToken), payload: { role: 'photo', contentType: 'image/webp', bytes: 1000 } });
  expect(p.statusCode).toBe(200);
  expect(new URL(p.json().url).pathname).toBe(`/activitees/${id}/${p.json().value}`);
  const get = (token: string) => app.inject({ url: `/phone/v3/media/${id}/x.webp`, headers: bearer(token) });
  expect((await get(a.phoneToken)).statusCode).toBe(302);
  expect((await get(b.phoneToken)).statusCode).toBe(302);
  const hid = randomUUID();
  await put(hid, { posted_at: T, content: withText() }, hidden.phoneToken);
  expect((await app.inject({ url: `/phone/v3/media/${hid}/x.webp`, headers: bearer(b.phoneToken) })).statusCode).toBe(404);
  expect((await app.inject({ url: `/phone/v3/media/${hid}/x.webp`, headers: bearer(hidden.phoneToken) })).statusCode).toBe(302);
});

test('own posts, newest first, a page at a time with a cursor; others\' and deleted ones are not in it', async () => {
  const ids: string[] = [randomUUID(), randomUUID(), randomUUID()];
  await put(ids[0], { posted_at: T + 10, content: withText({ title: 'one' }) });
  await put(ids[1], { posted_at: T + 20, content: withText({ title: 'two' }) });
  await put(ids[2], { posted_at: T + 30, content: withText({ title: 'three' }) });
  await put(randomUUID(), { posted_at: T + 40, content: withText() }, b.phoneToken);
  await del(ids[1]);
  const all = await own();
  expect(all.posts.filter((p) => ids.includes(p.postid)).map((p) => p.content.title)).toEqual(['three', 'one']);
  expect(all.posts.map((p) => p.postid)).not.toContain(ids[1]);
  expect(all.posts[0]).toMatchObject({ postid: ids[2], posted_at: T + 30, media_v2: [] });
  const first = await own('?limit=1');
  expect(first.posts).toHaveLength(1);
  expect(first.next).toBe(`${T + 30}.${ids[2]}`);
  const second = await own(`?limit=1&before=${first.next}`);
  expect(second.posts.map((p) => p.postid)).toContain(ids[0]);
  expect((await app.inject({ url: '/phone/v3/posts?before=junk', headers: bearer(a.phoneToken) })).statusCode).toBe(400);
});

test('the feed: posts and activities together, newest first, each with its kind; a post carries its content and media', async () => {
  const act = activity(a.phoneDownloadid, { startdate: T + 5000, enddate: T + 5100 });
  await phoneBatch(app, a.phoneToken, [act]);
  const postId = randomUUID();
  await put(postId, { posted_at: T + 6000, content: withText({ template: 'steps', steps: 4000, dtgraph: 1760000000 }) });
  const olderPost = randomUUID();
  await put(olderPost, { posted_at: T + 4000, content: withText({ title: 'older' }) });
  const mineInFeed = (await feed()).filter((p) => p.author.userid === a.userid);
  expect(mineInFeed.slice(0, 3).map((p) => p.kind)).toEqual(['post', 'activity', 'post']);
  expect(mineInFeed[0].post).toMatchObject({ postid: postId, content: { template: 'steps', steps: 4000, title: 'Morning' } });
  expect(mineInFeed[1].activity?.activityid).toBe(act.activityid);
  expect(mineInFeed[2].post?.postid).toBe(olderPost);
  expect(mineInFeed[0]).not.toHaveProperty('activity');
  expect(mineInFeed[1]).not.toHaveProperty('post');
});

test('the feed leaves out hidden profiles, deleted posts and a post that has nothing to show yet (made, media not uploaded)', async () => {
  const hid = randomUUID();
  await put(hid, { posted_at: T + 9000, content: withText() }, hidden.phoneToken);
  const gone = randomUUID();
  await put(gone, { posted_at: T + 9001, content: withText() });
  await del(gone);
  const empty = randomUUID();
  await put(empty, { posted_at: T + 9002, content: { v: 1, template: 'steps', steps: 10 }, media: 1 }); // media is coming, none has arrived
  const ids = (await feed()).map((p) => p.post?.postid);
  expect(ids).not.toContain(hid);
  expect(ids).not.toContain(gone);
  expect(ids).not.toContain(empty);
  // the author still has it (their phone shows it while the files go up), and it joins the feed when the first file is committed
  expect((await own()).posts.map((p) => p.postid)).toContain(empty);
  const v = name();
  upload(empty, v);
  await commit(empty, v);
  expect((await feed()).map((p) => p.post?.postid)).toContain(empty);
});

test('paging the feed through a mix of posts and activities never repeats or skips one', async () => {
  const seen: string[] = [];
  let before: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({ url: `/phone/v3/feed?limit=3${before ? `&before=${before}` : ''}`, headers: bearer(b.phoneToken) });
    const body = res.json() as { posts: { post?: { postid: string }; activity?: { activityid: string } }[]; next: string | null };
    seen.push(...body.posts.map((p) => (p.post?.postid ?? p.activity?.activityid) as string));
    if (!body.next) break;
    before = body.next;
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.length).toBeGreaterThan(5);
});

test('the feed reads posts with an index (no scan of the table)', async () => {
  const client = await app.pg.writer.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_sort = off');
    const plan = (await client.query('EXPLAIN SELECT postid FROM posts WHERE tosend = 1 ORDER BY posted_at DESC, postid DESC LIMIT 20')).rows.map((x) => x['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/posts_feed|posts_user/);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
