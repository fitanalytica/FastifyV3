import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';

let app: TestApp;
let a: Account, b: Account, hidden: Account, noProfile: Account;
const T = 1900000000; // far enough ahead that these are the newest in a test database

const addProfile = (acc: Account, over: { gmt?: number; hide?: boolean; fname?: string; iso?: string } = {}) =>
  app.pg.writer.query(
    `INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered) VALUES ($1, $2, 'Test', 68, $3, $4, 'Pune', 'MH', $5, 1700000000)`,
    [acc.userid, over.fname ?? 'Asha', over.gmt ?? 0, over.hide ?? false, over.iso ?? 'IN'],
  );
const post = (acc: Account, items: ReturnType<typeof activity>[]) =>
  app.inject({ method: 'POST', url: PHONE_BATCH, headers: bearer(acc.phoneToken), payload: { activities: items } });
const feed = async (token = a.phoneToken) => {
  const res = await app.inject({ url: '/phone/v3/feed', headers: bearer(token) });
  expect(res.statusCode).toBe(200);
  return res.json().posts as { author: Record<string, unknown>; activity: Record<string, unknown> & { activityid: string } }[];
};
const mine = async () => {
  return (await feed()).filter((p) => [a, b].some((x) => p.author.userid === x.userid));
};

beforeAll(async () => {
  app = await build();
  [a, b, hidden, noProfile] = [await createAccount(app), await createAccount(app), await createAccount(app), await createAccount(app)];
  await addProfile(a, { fname: 'Asha' });
  await addProfile(b, { fname: 'Ben', iso: 'GB', gmt: 7200 });
  await addProfile(hidden, { hide: true });
});
afterAll(async () => {
  for (const x of [a, b, hidden, noProfile]) await x.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[a.userid, b.userid, hidden.userid, noProfile.userid]]);
  await app.close();
});

const PREVIEW = { p: [1297160, 7759457, 12, -4, 3, 1] };

test('the recent activities, a user can have several, newest first, with the small part of each: the summary and the route preview, never the track', async () => {
  const older = activity(a.phoneDownloadid, { startdate: T - 7200, enddate: T - 3600 });
  const newer = activity(a.phoneDownloadid, { startdate: T, enddate: T + 1800, route_preview: PREVIEW });
  await post(a, [older, newer]);
  const posts = (await mine()).filter((p) => p.author.userid === a.userid);
  expect(posts.map((p) => p.activity.activityid)).toEqual([newer.activityid, older.activityid]);
  expect(posts[0].activity.route_preview).toEqual(PREVIEW);
  expect(posts[1].activity.route_preview).toBeNull();
  expect(posts[0].activity.lat).toBe(12.971599);
  expect(posts[0].activity.distance).toBe(9210);
  expect(posts[0].activity).not.toHaveProperty('userid');
  // the big arrays are not sent (the details screen reads the whole activity when it is opened)
  for (const big of ['activitylat', 'activitylon', 'activitytimenow', 'activityelevation', 'activitydistance', 'activitybpm_v2', 'activitydetail', 'activitybpm', 'media_details']) {
    expect(posts[0].activity, big).not.toHaveProperty(big);
  }
});

test('the author: name, weight, place and the country name from the server list', async () => {
  const p = (await mine()).find((x) => x.author.userid === a.userid)!;
  expect(p.author).toMatchObject({ fname: 'Asha', lname: 'Test', weight: 68, city: 'Pune', state: 'MH', iso: 'IN', country: 'India' });
});

test('newest first by end time, whoever it is: b ends after both of a\'s, so it is first (the user\'s own offset from GMT plays no part)', async () => {
  await post(b, [activity(b.phoneDownloadid, { startdate: T + 3600, enddate: T + 1800 + 3600 })]);
  const order = (await mine()).map((p) => p.author.userid);
  expect(order).toEqual([b.userid, a.userid, a.userid]);
});

test('hidden profiles and users without a profile are not in the feed', async () => {
  await post(hidden, [activity(hidden.phoneDownloadid, { startdate: T + 9000, enddate: T + 9100 })]);
  await post(noProfile, [activity(noProfile.phoneDownloadid, { startdate: T + 9000, enddate: T + 9100 })]);
  const users = (await feed()).map((p) => p.author.userid);
  expect(users).not.toContain(hidden.userid);
  expect(users).not.toContain(noProfile.userid);
});

test('a deleted activity leaves the feed', async () => {
  const before = (await mine()).filter((p) => p.author.userid === a.userid);
  const del = await app.inject({ method: 'DELETE', url: `/phone/v3/activities/${before[0].activity.activityid}`, headers: bearer(a.phoneToken) });
  expect(del.statusCode).toBeLessThan(300);
  const after = (await mine()).filter((p) => p.author.userid === a.userid);
  expect(after.map((p) => p.activity.activityid)).toEqual([before[1].activity.activityid]);
});

test('one user can have many posts: there is no limit per user (yet)', async () => {
  const many = Array.from({ length: 6 }, (_, i) => activity(b.phoneDownloadid, { startdate: T + 20000 + i * 100, enddate: T + 20050 + i * 100 }));
  await post(b, many);
  const fromB = (await feed()).filter((p) => p.author.userid === b.userid);
  expect(fromB.map((p) => p.activity.activityid).slice(0, 6)).toEqual([...many].reverse().map((x) => x.activityid));
});

test('a page of 20, then the rest by the cursor: newest first, every activity once, none skipped', async () => {
  const users = await Promise.all(Array.from({ length: 22 }, () => createAccount(app)));
  try {
    await Promise.all(users.map((u, i) => addProfile(u, { fname: `U${i}` })));
    await Promise.all(users.map((u, i) => post(u, [activity(u.phoneDownloadid, { startdate: T + 50000 + i * 100, enddate: T + 50050 + i * 100 })])));
    const first = (await app.inject({ url: '/phone/v3/feed', headers: bearer(a.phoneToken) })).json();
    expect(first.posts).toHaveLength(20);
    expect(first.next).toMatch(/^\d+\.[0-9a-f-]{36}$/);
    expect(first.posts[0].author.userid).toBe(users[21].userid);
    // the rest, two at a time, until the end
    type Post = { author: { userid: string }; activity: { activityid: string } };
    const seen: Post[] = [...first.posts];
    let next: string | null = first.next;
    for (let i = 0; i < 30 && next; i++) {
      const page = (await app.inject({ url: `/phone/v3/feed?limit=2&before=${next}`, headers: bearer(a.phoneToken) })).json();
      expect(page.posts.length).toBeLessThanOrEqual(2);
      seen.push(...page.posts);
      next = page.next;
    }
    const ids = seen.map((p) => p.activity.activityid);
    expect(new Set(ids).size).toBe(ids.length); // none twice
    // the 22 users' activities are the newest: they head what was read, newest first, across the page boundary
    expect(seen.slice(0, 22).map((p) => p.author.userid)).toEqual([...users].reverse().map((u) => u.userid));
  } finally {
    await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [users.map((u) => u.userid)]);
    for (const u of users) await u.remove();
  }
});

test('a newer activity arriving between pages does not move the next page', async () => {
  const p1 = (await app.inject({ url: '/phone/v3/feed?limit=2', headers: bearer(a.phoneToken) })).json();
  await post(b, [activity(b.phoneDownloadid, { startdate: T + 90000, enddate: T + 90100 })]);
  const p2 = (await app.inject({ url: `/phone/v3/feed?limit=2&before=${p1.next}`, headers: bearer(a.phoneToken) })).json();
  const ids1 = p1.posts.map((p: { activity: { activityid: string } }) => p.activity.activityid);
  const ids2 = p2.posts.map((p: { activity: { activityid: string } }) => p.activity.activityid);
  expect(ids2.some((id: string) => ids1.includes(id))).toBe(false);
});

test('a bad cursor or limit is a 400', async () => {
  expect((await app.inject({ url: '/phone/v3/feed?before=nonsense', headers: bearer(a.phoneToken) })).statusCode).toBe(400);
  expect((await app.inject({ url: '/phone/v3/feed?limit=500', headers: bearer(a.phoneToken) })).statusCode).toBe(400);
  expect((await app.inject({ url: '/phone/v3/feed?limit=0', headers: bearer(a.phoneToken) })).statusCode).toBe(400);
});

test('the feed is for the phone: a watch token is refused', async () => {
  const res = await app.inject({ url: '/phone/v3/feed', headers: bearer(a.watchToken) });
  expect(res.statusCode).toBe(403);
});

test('no token, no feed', async () => {
  expect((await app.inject({ url: '/phone/v3/feed' })).statusCode).toBe(400); // a missing header is a 400 on every secured route
});

// ---------------------------------------------------------------------------------------------------------------------------------- one activity in full

const one = (id: string, token = b.phoneToken) => app.inject({ url: `/phone/v3/feed/${id}`, headers: bearer(token) });

test('one activity in full, for the details screen: the author and the activity exactly as a restore row, with its track', async () => {
  const full = activity(a.phoneDownloadid, { startdate: T + 70000, enddate: T + 71800, route_preview: PREVIEW });
  await post(a, [full]);
  const res = await one(full.activityid);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.author).toMatchObject({ userid: a.userid, fname: 'Asha', country: 'India' });
  expect(body.activity.activitylat).toEqual([0, 12, 15]);   // the track is there, compact
  expect(body.activity.activitytimenow).toEqual([1731480000, 1, 2]);
  expect(body.activity.route_preview).toEqual(PREVIEW);
  expect(body.activity.lat).toBe(12.971599);
  expect(body.activity).not.toHaveProperty('userid');
});

test('one activity: the owner can always read their own; a hidden profile\'s is for its owner only; a deleted or unknown one is a 404', async () => {
  const mineAct = activity(hidden.phoneDownloadid, { startdate: T + 80000, enddate: T + 81000 });
  await post(hidden, [mineAct]);
  expect((await one(mineAct.activityid, hidden.phoneToken)).statusCode).toBe(200);        // the owner
  expect((await one(mineAct.activityid, b.phoneToken)).statusCode).toBe(404);             // someone else: the profile is hidden
  const gone = activity(a.phoneDownloadid, { startdate: T + 90000, enddate: T + 91000 });
  await post(a, [gone]);
  await app.inject({ method: 'DELETE', url: `/phone/v3/activities/${gone.activityid}`, headers: bearer(a.phoneToken) });
  expect((await one(gone.activityid)).statusCode).toBe(404);
  expect((await one(randomUUID())).statusCode).toBe(404);
  expect((await one('not-a-uuid')).statusCode).toBe(400);
  expect((await app.inject({ url: `/phone/v3/feed/${gone.activityid}`, headers: bearer(a.watchToken) })).statusCode).toBe(403);
});

test('the feed query can read the newest activities through its index (it matches the order and the filter), so the table is not scanned at scale', async () => {
  // On a handful of test rows the planner rightly prefers a plain scan and a sort, so both are switched off to see which index can serve the ORDER BY.
  const client = await app.pg.writer.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_sort = off'); // so only an index that already has the order can serve it
    const plan = (await client.query(
      `EXPLAIN SELECT a.activityid FROM activities a JOIN userinfo u ON u.userid = a.userid
        WHERE a.tosend IN (1, 2) AND u.hideprofile = false ORDER BY a.enddate DESC, a.activityid DESC LIMIT 21`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/activities_feed/);
    expect(plan).not.toMatch(/Sort/); // already in order: no sorting of the whole set
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('a page the phone already has is answered 304 with no body: its ETag is the same until something in the page changes', async () => {
  const first = await app.inject({ url: '/phone/v3/feed?limit=3', headers: bearer(a.phoneToken) });
  const etag = first.headers.etag as string;
  expect(etag).toMatch(/^W\/"/);
  expect(first.headers['cache-control']).toBe('private, no-cache');
  const again = await app.inject({ url: '/phone/v3/feed?limit=3', headers: { ...bearer(a.phoneToken), 'if-none-match': etag } });
  expect(again.statusCode).toBe(304);
  expect(again.body).toBe('');
  // a different tag (or none) gets the page again
  expect((await app.inject({ url: '/phone/v3/feed?limit=3', headers: { ...bearer(a.phoneToken), 'if-none-match': 'W/"other"' } })).statusCode).toBe(200);
  // a new activity changes the page, so the old tag no longer matches
  await post(b, [activity(b.phoneDownloadid, { startdate: T + 95000, enddate: T + 96000 })]);
  const changed = await app.inject({ url: '/phone/v3/feed?limit=3', headers: { ...bearer(a.phoneToken), 'if-none-match': etag } });
  expect(changed.statusCode).toBe(200);
  expect(changed.headers.etag).not.toBe(etag);
});
