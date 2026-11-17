import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';

// Someone's profile and their own feed (docs/data/api.md section 14).
let app: TestApp;
let a: Account, viewer: Account, hidden: Account;
const T = 1960000000; // a day in 2032: the monthly rows are checked by name, not by "now"

const addProfile = (acc: Account, over: { hide?: boolean; about?: string; gmt?: number } = {}) =>
  app.pg.writer.query(
    `INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, about, dateregistered) VALUES ($1, 'Asha', 'Test', 68, $2, $3, 'Pune', 'MH', 'IN', $4, 1700000000)`,
    [acc.userid, over.gmt ?? 0, over.hide ?? false, over.about ?? null],
  );
const send = (acc: Account, items: ReturnType<typeof activity>[]) =>
  app.inject({ method: 'POST', url: PHONE_BATCH, headers: bearer(acc.phoneToken), payload: { activities: items } });
const get = (url: string, token = viewer.phoneToken) => app.inject({ url, headers: bearer(token) });
const profile = (id: string, token = viewer.phoneToken) => get(`/phone/v3/users/${id}`, token);
const feed = async (id: string, qs = '', token = viewer.phoneToken) => (await get(`/phone/v3/users/${id}/feed${qs}`, token)).json() as { posts: { kind: string; author: { userid: string }; activity?: { activityid: string }; post?: { postid: string } }[]; next: string | null };
const putPost = (id: string, body: object) => app.inject({ method: 'PUT', url: `/phone/v3/posts/${id}`, headers: bearer(a.phoneToken), payload: body as object });

let first: ReturnType<typeof activity>, second: ReturnType<typeof activity>, third: ReturnType<typeof activity>, postid: string;

beforeAll(async () => {
  app = await build();
  [a, viewer, hidden] = [await createAccount(app), await createAccount(app), await createAccount(app)];
  await addProfile(a, { about: 'Runs at dawn' });
  await addProfile(viewer);
  await addProfile(hidden, { hide: true });
  // three activities: two in one month (the second the fastest and the longest), one a month earlier
  first = activity(a.phoneDownloadid, { startdate: T, enddate: T + 3000, duration: 3000, distance: 6000 });
  second = activity(a.phoneDownloadid, { startdate: T + 7200, enddate: T + 7200 + 2400, duration: 2400, distance: 10000 });
  third = activity(a.phoneDownloadid, { startdate: T - 40 * 86400, enddate: T - 40 * 86400 + 1000, duration: 1000, distance: 500 });
  expect((await send(a, [first, second, third])).statusCode).toBe(200);
  await send(hidden, [activity(hidden.phoneDownloadid, { startdate: T, enddate: T + 100 })]);
  postid = randomUUID();
  expect((await putPost(postid, { posted_at: T + 10000, content: { v: 1, title: 'Hello' } })).statusCode).toBe(200);
  await app.pg.writer.query(`UPDATE activities SET media_v2 = '[{"type":"photo","value":"x.webp","dimension":[4,3]},{"type":"photo","value":"y.webp","dimension":[4,3]}]'::jsonb WHERE activityid = $1`, [second.activityid]);
});
afterAll(async () => {
  for (const x of [a, viewer, hidden]) await x.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[a.userid, viewer.userid, hidden.userid]]);
  await app.close();
});

test('who they are, how many activities and photos, the totals, a row per month, and three bests', async () => {
  const res = await profile(a.userid);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.user).toMatchObject({ userid: a.userid, fname: 'Asha', lname: 'Test', about: 'Runs at dawn', city: 'Pune', iso: 'IN', country: 'India' });
  expect(body.counts).toEqual({ activities: 3, photos: 2 });
  expect(body.totals).toEqual({ distance: 16500, duration: 6400 });
  expect(body.monthly).toHaveLength(2);
  expect(body.monthly[0]).toMatchObject({ n: 2, distance: 16000, duration: 5400 });
  expect(body.monthly[1]).toMatchObject({ n: 1, distance: 500, duration: 1000 });
  expect(body.monthly[0].ym > body.monthly[1].ym).toBe(true);
  // the shortest ride (500 m) is too short to count for a pace: the fastest is the 10 km one at 240 s/km
  expect(body.bests).toEqual({ longest_distance: 10000, longest_duration: 3000, fastest_sec_per_km: 240 });
});

test('a user with nothing: zeros and no bests, not an error', async () => {
  const res = await profile(viewer.userid);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ counts: { activities: 0, photos: 0 }, totals: { distance: 0, duration: 0 }, monthly: [], bests: { longest_distance: null, longest_duration: null, fastest_sec_per_km: null } });
});

test('a hidden profile is 404 for others and open to its owner; unknown and malformed ids are refused', async () => {
  expect((await profile(hidden.userid)).statusCode).toBe(404);
  expect((await profile(hidden.userid, hidden.phoneToken)).statusCode).toBe(200);
  expect((await feed(hidden.userid) as unknown as { code?: string }).code).toBe('NOT_FOUND');
  expect((await profile(randomUUID())).statusCode).toBe(404);
  expect((await get('/phone/v3/users/not-a-uuid')).statusCode).toBe(400);
});

test('their feed: activities and posts, newest first, in the shape of the feed, with the author', async () => {
  const f = await feed(a.userid);
  expect(f.posts.map((p) => p.kind)).toEqual(['post', 'activity', 'activity', 'activity']);
  expect(f.posts[0].post!.postid).toBe(postid);
  expect(f.posts.slice(1).map((p) => p.activity!.activityid)).toEqual([second.activityid, first.activityid, third.activityid]);
  expect(f.posts.every((p) => p.author.userid === a.userid)).toBe(true);
  expect(f.next).toBeNull();
});

test('kind and media narrow it; a cursor pages it', async () => {
  expect((await feed(a.userid, '?kind=activity')).posts.map((p) => p.kind)).toEqual(['activity', 'activity', 'activity']);
  expect((await feed(a.userid, '?kind=post')).posts.map((p) => p.kind)).toEqual(['post']);
  expect((await feed(a.userid, '?media=true')).posts.map((p) => p.activity?.activityid)).toEqual([second.activityid]);
  const one = await feed(a.userid, '?limit=2');
  expect(one.posts).toHaveLength(2);
  expect(one.next).not.toBeNull();
  const rest = await feed(a.userid, `?limit=2&before=${one.next}`);
  expect(rest.posts.map((p) => p.activity?.activityid)).toEqual([first.activityid, third.activityid]);
  expect(rest.next).toBeNull();
});

test('a deleted activity and a deleted post are not listed or counted', async () => {
  await app.inject({ method: 'DELETE', url: `/phone/v3/activities/${third.activityid}`, headers: bearer(a.phoneToken) });
  await app.inject({ method: 'DELETE', url: `/phone/v3/posts/${postid}`, headers: bearer(a.phoneToken) });
  expect((await feed(a.userid)).posts.map((p) => p.kind)).toEqual(['activity', 'activity']);
  expect((await profile(a.userid)).json().counts.activities).toBe(2);
});
