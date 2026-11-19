import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';

// Redeeming an invite code (docs/data/api.md section 15): claimed once, for one user, atomically.
let app: TestApp;
let buyer: Account;
let users: Account[] = [];
const STORE_ID = randomUUID();
const NOW = () => Math.floor(Date.now() / 1000);
const LIFETIME_S = 9999999999;
const user = async () => { const u = await createAccount(app); users.push(u); return u; };

const redeem = (u: Account, code: string) => app.inject({ method: 'POST', url: '/phone/v3/redeem', headers: bearer(u.phoneToken), payload: { code } });
const seed = (table: string, v: { code?: string | null; by?: string | null; expires?: number | null; product?: string; ref?: string; redeemed?: number | null }) =>
  app.pg.writer.query(
    `INSERT INTO ${table} (buyer_userid, invite_code, redeemed_by_userid, expires_date, product_id, reference_id, redeemed_date) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [buyer.userid, v.code ?? null, v.by ?? null, v.expires ?? null, v.product ?? 'fitanalytica.groups.lifetime.49', v.ref ?? 'ref-' + randomUUID().slice(0, 8), v.redeemed ?? null],
  );
const row = async (table: string, code: string) => (await app.pg.writer.query(`SELECT * FROM ${table} WHERE invite_code = $1`, [code])).rows[0];

beforeAll(async () => {
  app = await build();
  buyer = await createAccount(app);
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, seconds_from_gmt, dateregistered, store_id) VALUES ($1, 'Pat', 0, 1700000000, $2)`, [buyer.userid, STORE_ID]);
});
afterEach(async () => {
  delete process.env.BILLING_ENV;
  const ids = [buyer.userid, ...users.map((u) => u.userid)];
  for (const t of ['membership', 'membership_sandbox']) await app.pg.writer.query(`DELETE FROM ${t} WHERE buyer_userid = ANY($1) OR redeemed_by_userid = ANY($1)`, [ids]);
  for (const u of users) await u.remove();
  users = [];
});
afterAll(async () => {
  await buyer.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [buyer.userid]);
  await app.close();
});

test('a code of a lifetime pack gives a lifetime, as a gift; the buyer\'s account token comes back for the phone\'s analytics', async () => {
  const u = await user();
  await seed('membership', { code: 'ABCD-EFGH' });
  const res = await redeem(u, 'ABCD-EFGH');
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.redeemed).toMatchObject({ productId: 'fitanalytica.groups.lifetime.49', referrerStoreId: STORE_ID, alert: { title: "You're now Pro" } });
  expect(body.entitlement).toMatchObject({ pro: true, source: 'gifted', lifetime: true, expiresAt: null });
  const r = await row('membership', 'ABCD-EFGH');
  expect(r.redeemed_by_userid).toBe(u.userid);
  expect(Number(r.expires_date)).toBe(LIFETIME_S);
  expect(Number(r.redeemed_date)).toBeGreaterThan(NOW() - 60);
});

test('as typed or linked: any case, with or without the dash, with spaces around', async () => {
  for (const typed of ['abcd-efgh', 'ABCDEFGH', '  abcd efgh ']) {
    const u = await user();
    await seed('membership', { code: 'ABCD-EFGH' });
    expect((await redeem(u, typed)).statusCode).toBe(200);
    await app.pg.writer.query('DELETE FROM membership WHERE buyer_userid = $1', [buyer.userid]);
  }
});

test('refusals: no such code, not a code at all, already redeemed (by someone else, or by me), and already Pro', async () => {
  const [u, other] = [await user(), await user()];
  await seed('membership', { code: 'USED-0001', by: other.userid, expires: LIFETIME_S, redeemed: 1700000000 });
  await seed('membership', { code: 'MINE-0001', by: u.userid, expires: LIFETIME_S, redeemed: 1700000000 });
  const e = async (code: string, who = u) => { const r = await redeem(who, code); return [r.statusCode, r.json().code, r.json().message]; };
  expect(await e('NOPE-0000')).toEqual([404, 'CODE_INVALID', 'Invalid invite code']);
  expect(await e('abc')).toEqual([404, 'CODE_INVALID', 'Invalid invite code']);
  expect(await e('USED-0001')).toEqual([409, 'CODE_USED', 'This code has been redeemed']);
  expect(await e('MINE-0001')).toEqual([409, 'CODE_USED', 'You have redeemed this code']);
  await seed('membership', { code: 'FREE-0001' });
  expect(await e('FREE-0001')).toEqual([409, 'ALREADY_PRO', 'You have an active Pro membership']);
  expect((await row('membership', 'FREE-0001')).redeemed_by_userid).toBeNull();
});

test('two people redeeming the same code at the same moment: one gets it', async () => {
  const [x, y] = [await user(), await user()];
  await seed('membership', { code: 'RACE-0001' });
  const res = await Promise.all([redeem(x, 'RACE-0001'), redeem(y, 'RACE-0001')]);
  expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(res.find((r) => r.statusCode === 409)!.json().code).toBe('CODE_USED');
});

test('one person redeeming two codes at the same moment: they get one (the second finds them Pro)', async () => {
  const x = await user();
  await seed('membership', { code: 'TWIN-0001' });
  await seed('membership', { code: 'TWIN-0002' });
  const res = await Promise.all([redeem(x, 'TWIN-0001'), redeem(x, 'TWIN-0002')]);
  expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(res.find((r) => r.statusCode === 409)!.json().code).toBe('ALREADY_PRO');
});

test('a code of a plan follows the end of the buyer\'s plan; when that has ended, or there is no plan to follow, it is expired', async () => {
  const [x, y, z] = [await user(), await user(), await user()];
  const end = NOW() + 86400;
  await seed('membership', { ref: 'plan-live', product: 'plan.a', expires: end * 1000 });
  await seed('membership', { code: 'PLAN-0001', ref: 'plan-live', product: 'plan.a' });
  const ok = await redeem(x, 'PLAN-0001');
  expect(ok.statusCode).toBe(200);
  expect(ok.json().entitlement).toMatchObject({ pro: true, lifetime: false, expiresAt: end });
  await seed('membership', { ref: 'plan-dead', product: 'plan.a', expires: NOW() - 100 });
  await seed('membership', { code: 'PLAN-0002', ref: 'plan-dead', product: 'plan.a' });
  await seed('membership', { code: 'PLAN-0003', ref: 'no-plan', product: 'plan.a' });
  for (const [who, code] of [[y, 'PLAN-0002'], [z, 'PLAN-0003']] as const) {
    const r = await redeem(who, code);
    expect([r.statusCode, r.json().code]).toEqual([400, 'CODE_EXPIRED']);
  }
  expect((await row('membership', 'PLAN-0002')).redeemed_by_userid).toBeNull();
});

test('a sandbox code is found only where BILLING_ENV reads the sandbox table', async () => {
  const x = await user();
  await seed('membership_sandbox', { code: 'SAND-0001' });
  expect((await redeem(x, 'SAND-0001')).statusCode).toBe(404);
  process.env.BILLING_ENV = 'both';
  expect((await redeem(x, 'SAND-0001')).statusCode).toBe(200);
  expect((await row('membership_sandbox', 'SAND-0001')).redeemed_by_userid).toBe(x.userid);
});

test('codes cannot be guessed: ten tries a minute per token, then 429; and a token is needed', async () => {
  const x = await user();
  const codes = Array.from({ length: 11 }, (_, i) => `GUES-${String(i).padStart(4, '0')}`);
  const answers: number[] = [];
  for (const c of codes) answers.push((await redeem(x, c)).statusCode);
  expect(answers.slice(0, 10)).toEqual(Array(10).fill(404));
  expect(answers[10]).toBe(429);
  expect((await app.inject({ method: 'POST', url: '/phone/v3/redeem', payload: { code: 'ABCD-EFGH' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/phone/v3/redeem', headers: bearer(x.watchToken), payload: { code: 'ABCD-EFGH' } })).statusCode).toBe(403);
});
