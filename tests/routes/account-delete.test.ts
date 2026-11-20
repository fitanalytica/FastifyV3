import { test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { PHONE_BATCH, activity, bearer } from '../helpers/fixtures.js';
import { phoneBatch, probe } from '../helpers/viaSync.js';

// Deleting an account (docs/data/api.md section 8b): the e-mailed code, then every row and every file of the user. S3, e-mail and Apple are stand-ins.
const fake = vi.hoisted(() => ({
  folders: [] as string[],
  profileFiles: [] as string[],
  failFolders: false,
  mails: [] as { to: string; subject: string; body: string }[],
  revoked: [] as string[],
  revokeOk: true,
}));
vi.mock('../../src/services/media/s3Ops.js', () => ({
  headObject: async () => null,
  deleteObjects: async (keys: string[], bucket = 'media') => { if (bucket === 'profile') fake.profileFiles.push(...keys); },
  deleteFolder: async (id: string) => { if (fake.failFolders) throw new Error('S3 is down'); fake.folders.push(id); return 0; },
}));
vi.mock('../../src/services/email/sendEmail.js', () => ({
  emailConfigured: () => true,
  sendEmail: async (m: { to: string; subject: string; body: string }) => { fake.mails.push(m); },
}));
vi.mock('../../src/services/auth/providers/apple.js', () => ({
  revokeAppleToken: async (t: string) => { fake.revoked.push(t); return fake.revokeOk; },
  exchangeAppleCode: async () => null,
  appleClientSecret: async () => '',
  appleConfigured: () => true,
}));

let app: TestApp;
let a: Account, other: Account;
const made: Account[] = [];

beforeAll(async () => {
  app = await build();
  other = await createAccount(app);
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, hideprofile, dateregistered) VALUES ($1, 'Other', false, 1700000000)`, [other.userid]);
});
afterAll(async () => {
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[other.userid, ...made.map((m) => m.userid)]]);
  for (const x of [other, ...made]) await x.remove();
  await app.pg.writer.query('DELETE FROM paymentstore WHERE userid = ANY($1)', [made.map((m) => m.userid)]);
  await app.close();
});
beforeEach(() => {
  Object.assign(fake, { folders: [], profileFiles: [], failFolders: false, mails: [], revoked: [], revokeOk: true });
});

const w = () => app.pg.writer;
const count = async (sql: string, ...p: unknown[]) => Number((await w().query(sql, p)).rows[0].n);

/** A user with an e-mail address, a profile with a picture and a cover, two activities, a post, and an Apple grant on their phone's token. */
async function user(over: { email?: string | null; profilepic?: string | null } = {}) {
  const acc = await createAccount(app);
  made.push(acc);
  await w().query('UPDATE userlogin SET email = $2 WHERE userid = $1', [acc.userid, over.email === undefined ? `u${acc.userid.slice(0, 6)}@example.com` : over.email]);
  await w().query(
    `INSERT INTO userinfo (userid, fname, hideprofile, profilepic, profilebg, dateregistered) VALUES ($1, 'Pat', false, $2, 'cover.webp', 1700000000)`,
    [acc.userid, over.profilepic === undefined ? 'pic.webp' : over.profilepic],
  );
  const acts = [activity(acc.phoneDownloadid, { startdate: 1_960_000_000, enddate: 1_960_000_100 }), activity(acc.phoneDownloadid, { startdate: 1_960_001_000, enddate: 1_960_001_100 })];
  await phoneBatch(app, acc.phoneToken, acts);
  const postid = randomUUID();
  await app.inject({ method: 'PUT', url: `/phone/v3/posts/${postid}`, headers: bearer(acc.phoneToken), payload: { posted_at: 1_960_002_000, content: { v: 1, title: 'Hello' } } });
  await w().query('UPDATE usertokens SET apple_refresh_token = $2 WHERE userid = $1 AND device = $3', [acc.userid, `apple-${acc.userid.slice(0, 8)}`, 'test']);
  return { acc, activityids: acts.map((x) => x.activityid), postid };
}
const ask = (acc: Account) => app.inject({ method: 'POST', url: '/phone/v3/account/delete-code', headers: bearer(acc.phoneToken) });
const codeFrom = (n = 0) => /code is (\d{6})/.exec(fake.mails[n].body)![1];
const verify = (acc: Account, code: string) => app.inject({ method: 'POST', url: '/phone/v3/account/delete-code/verify', headers: bearer(acc.phoneToken), payload: { code } });
const remove = (acc: Account, code: string) => app.inject({ method: 'DELETE', url: '/phone/v3/account', headers: bearer(acc.phoneToken), payload: { code } });
/** Asks for a code and lets the resend wait pass (the wait is checked against the stored time). */
const codeFor = async (acc: Account) => {
  await w().query('UPDATE account_deletion_codes SET sent_at = sent_at - 60 WHERE userid = $1', [acc.userid]);
  expect((await ask(acc)).statusCode).toBe(200);
  return codeFrom(fake.mails.length - 1);
};

test('the code goes to the address the account has (never one the app says), and only its hash is kept', async () => {
  const { acc } = await user();
  const res = await ask(acc);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ expiresIn: 600, resendIn: 30 });
  expect(fake.mails).toHaveLength(1);
  expect(fake.mails[0].to).toBe(`u${acc.userid.slice(0, 6)}@example.com`);
  expect(fake.mails[0].subject).toContain('Confirm deleting');
  const stored = (await w().query('SELECT code_hash FROM account_deletion_codes WHERE userid = $1', [acc.userid])).rows[0].code_hash.trim();
  expect(stored).toMatch(/^[0-9a-f]{64}$/);
  expect(stored).not.toContain(codeFrom());
});

test('an account with no e-mail address cannot be sent a code', async () => {
  const { acc } = await user({ email: null });
  const res = await ask(acc);
  expect(res.statusCode).toBe(400);
  expect(fake.mails).toHaveLength(0);
});

test('asking again too soon waits; after the wait a new code replaces the old one; five an hour at most', async () => {
  const { acc } = await user();
  await ask(acc);
  expect((await ask(acc)).statusCode).toBe(429);
  const first = codeFrom(0);
  const second = await codeFor(acc);
  expect((await verify(acc, second)).statusCode).toBe(204);
  if (second !== first) expect((await verify(acc, first)).statusCode).toBe(400);
  for (let i = 0; i < 3; i++) await codeFor(acc);
  await w().query('UPDATE account_deletion_codes SET sent_at = sent_at - 60 WHERE userid = $1', [acc.userid]);
  expect((await ask(acc)).statusCode).toBe(429); // the sixth in the hour
});

test('a wrong code is refused and counted; after five the right one is dead too; an old code is dead', async () => {
  const { acc } = await user();
  await ask(acc);
  const code = codeFrom();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const res = await verify(acc, wrong);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('DELETE_CODE_WRONG');
  }
  expect((await verify(acc, code)).statusCode).toBe(400);
  expect((await remove(acc, code)).statusCode).toBe(400);
  // a fresh code works, and one past its time does not
  const fresh = await codeFor(acc);
  expect((await verify(acc, fresh)).statusCode).toBe(204);
  await w().query('UPDATE account_deletion_codes SET expires_at = expires_at - 700 WHERE userid = $1', [acc.userid]);
  expect((await verify(acc, fresh)).statusCode).toBe(400);
  expect(await count('SELECT count(*) AS n FROM userlogin WHERE userid = $1', acc.userid)).toBe(1);
});

test('a malformed code and no code at all are refused; nobody signed in is refused', async () => {
  const { acc } = await user();
  expect((await verify(acc, '12345')).statusCode).toBe(400);
  expect((await verify(acc, 'abcdef')).statusCode).toBe(400);
  expect((await app.inject({ method: 'DELETE', url: '/phone/v3/account', headers: bearer(acc.phoneToken), payload: {} })).statusCode).toBe(400);
  expect((await app.inject({ method: 'DELETE', url: '/phone/v3/account', payload: { code: '123456' } })).statusCode).toBe(400);
  expect((await remove(acc, '123456')).statusCode).toBe(400); // no code was asked for
});

test('deleting: every row, every file and every Apple grant of the user go; every device is signed out; other users are untouched', async () => {
  const { acc, activityids, postid } = await user();
  await ask(acc);
  const code = codeFrom();
  expect((await remove(acc, code)).statusCode).toBe(204);

  for (const table of ['userlogin', 'userinfo', 'activities', 'posts', 'usertokens', 'downloads', 'account_deletion_codes']) {
    expect(await count(`SELECT count(*) AS n FROM ${table} WHERE userid = $1`, acc.userid), table).toBe(0);
  }
  expect(fake.folders.sort()).toEqual([...activityids, postid].sort());
  expect(fake.profileFiles.sort()).toEqual(['cover.webp', 'pic.webp']);
  expect(fake.revoked).toEqual([`apple-${acc.userid.slice(0, 8)}`]);
  // every device is out
  expect((await probe(app, acc.phoneToken)).statusCode).toBeGreaterThanOrEqual(401);
  expect((await probe(app, acc.watchToken)).statusCode).toBeGreaterThanOrEqual(401);
  // someone else is still there
  expect(await count('SELECT count(*) AS n FROM userinfo WHERE userid = $1', other.userid)).toBe(1);
  expect((await probe(app, other.phoneToken)).statusCode).toBe(200);
});

test('a picture that is a provider\'s https address (the old app) is not treated as a file', async () => {
  const { acc } = await user({ profilepic: 'https://lh3.googleusercontent.com/a/photo=s96-c' });
  await ask(acc);
  expect((await remove(acc, codeFrom())).statusCode).toBe(204);
  expect(fake.profileFiles).toEqual(['cover.webp']);
});

test('S3 does not answer: the request fails, NOTHING else is deleted, the user can still use the account, and the same request carries on', async () => {
  const { acc } = await user();
  await ask(acc);
  const code = codeFrom();
  fake.failFolders = true;
  const res = await remove(acc, code);
  expect(res.statusCode).toBe(502);
  expect(res.json().code).toBe('DELETE_FAILED');
  expect(await count('SELECT count(*) AS n FROM userlogin WHERE userid = $1', acc.userid)).toBe(1);
  expect(await count('SELECT count(*) AS n FROM activities WHERE userid = $1', acc.userid)).toBe(2);
  expect(await count('SELECT count(*) AS n FROM userinfo WHERE userid = $1 AND deleted_date IS NOT NULL AND hideprofile', acc.userid)).toBe(1);
  expect((await probe(app, acc.phoneToken)).statusCode).toBe(200);
  expect(fake.revoked).toEqual([]); // Apple is told only once the files are gone
  fake.failFolders = false;
  expect((await remove(acc, code)).statusCode).toBe(204);
  expect(await count('SELECT count(*) AS n FROM userlogin WHERE userid = $1', acc.userid)).toBe(0);
});

test('an install shared with another account (its activities still point at the install row): the deletion works and the install row stays', async () => {
  const { acc } = await user();
  const sharer = await createAccount(app);
  made.push(sharer);
  // the same install, later used by someone else, whose activity points at it
  const shared = acc.phoneDownloadid;
  await w().query('UPDATE downloads SET userid = $2 WHERE downloadid = $1', [shared, acc.userid]);
  await w().query(`INSERT INTO activities (activityid, userid, downloadid, startdate, enddate, duration, distance, tosend, geom) VALUES ($1, $2, $3, 1960005000, 1960005100, 10, 100, 1, '(0,0)')`, [randomUUID(), sharer.userid, shared]);
  await ask(acc);
  expect((await remove(acc, codeFrom())).statusCode).toBe(204);
  expect(await count('SELECT count(*) AS n FROM userlogin WHERE userid = $1', acc.userid)).toBe(0);
  expect(await count('SELECT count(*) AS n FROM downloads WHERE downloadid = $1', shared)).toBe(1); // still pointed at
  expect(await count('SELECT count(*) AS n FROM downloads WHERE downloadid = $1', acc.watchDownloadid)).toBe(0);
  expect(await count('SELECT count(*) AS n FROM activities WHERE userid = $1', sharer.userid)).toBe(1);
  await w().query('DELETE FROM activities WHERE userid = $1', [sharer.userid]);
  await w().query('DELETE FROM downloads WHERE downloadid = $1', [shared]);
});

test('Apple refuses the revoke: the account is deleted all the same', async () => {
  const { acc } = await user();
  await ask(acc);
  fake.revokeOk = false;
  expect((await remove(acc, codeFrom())).statusCode).toBe(204);
  expect(fake.revoked).toHaveLength(1);
  expect(await count('SELECT count(*) AS n FROM userlogin WHERE userid = $1', acc.userid)).toBe(0);
});

test('a user who bought a subscription keeps their profile row for billing (hidden, without the pictures); everything else goes', async () => {
  const { acc } = await user();
  await w().query(`INSERT INTO paymentstore (userid, ddate, product_id) VALUES ($1, 1, 'premium')`, [acc.userid]);
  await ask(acc);
  expect((await remove(acc, codeFrom())).statusCode).toBe(204);
  expect(await count('SELECT count(*) AS n FROM userlogin WHERE userid = $1', acc.userid)).toBe(0);
  expect(await count('SELECT count(*) AS n FROM activities WHERE userid = $1', acc.userid)).toBe(0);
  expect(await count('SELECT count(*) AS n FROM downloads WHERE userid = $1', acc.userid)).toBe(0);
  const kept = (await w().query('SELECT fname, deleted_date, hideprofile, profilepic, profilebg FROM userinfo WHERE userid = $1', [acc.userid])).rows[0];
  expect(kept).toMatchObject({ fname: 'Pat', hideprofile: true, profilepic: null, profilebg: null });
  expect(kept.deleted_date).toBeGreaterThan(1_700_000_000);
  expect(fake.profileFiles.sort()).toEqual(['cover.webp', 'pic.webp']); // the files go, the row stays
  // and the kept row is never shown
  expect((await app.inject({ url: `/phone/v3/users/${acc.userid}`, headers: bearer(other.phoneToken) })).statusCode).toBe(404);
});
