import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { buildCatalog, findProduct } from '../../src/services/store/getCatalog.js';
import { CATALOG_DATA, type CatalogData } from '../../src/services/store/catalogData.js';
import { phoneState, phoneProfilePut } from '../helpers/viaSync.js';

// What the user has and what is on sale (docs/data/api.md section 15). The membership table is shared with the v2 API: its expiry is in seconds (Android) or in milliseconds
// (iOS), and both must count the same.
let app: TestApp;
let a: Account, b: Account, noProfile: Account;
const NOW = () => Math.floor(Date.now() / 1000);
const LIFETIME_MS = 9999999999999;
const LIFETIME_S = 9999999999;

const state = async (query = '', token = a.phoneToken) => phoneState(app, token, Object.fromEntries(new URLSearchParams(query)));
const member = (table: string, v: { buyer?: string; code?: string | null; by?: string | null; expires?: number | null; product?: string; ref?: string; created?: number; shared?: number | null; redeemed?: number | null }) =>
  app.pg.writer.query(
    `INSERT INTO ${table} (buyer_userid, invite_code, redeemed_by_userid, expires_date, product_id, reference_id, created_date, shared_date, redeemed_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [v.buyer ?? a.userid, v.code ?? null, v.by ?? null, v.expires ?? null, v.product ?? 'fitanalytica.groups.lifetime.29', v.ref ?? randomUUID().slice(0, 20), v.created ?? 1700000000, v.shared ?? null, v.redeemed ?? null],
  );

beforeAll(async () => {
  app = await build();
  [a, b, noProfile] = [await createAccount(app), await createAccount(app), await createAccount(app)];
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered, store_id) VALUES ($1, '  Pat ', 'Test', 68, 0, false, 'Pune', 'MH', 'IN', 1700000000, gen_random_uuid())`, [b.userid]);
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, seconds_from_gmt, dateregistered) VALUES ($1, 'Old', 0, 1700000000)`, [a.userid]);
});
afterEach(async () => {
  delete process.env.BILLING_ENV;
  for (const t of ['membership', 'membership_sandbox']) await app.pg.writer.query(`DELETE FROM ${t} WHERE buyer_userid = ANY($1) OR redeemed_by_userid = ANY($1)`, [[a.userid, b.userid]]);
  await app.pg.writer.query('DELETE FROM protection_logs WHERE userid = ANY($1)', [[a.userid, b.userid]]);
});
afterAll(async () => {
  for (const x of [a, b, noProfile]) await x.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[a.userid, b.userid, noProfile.userid]]);
  await app.close();
});

test('a user with nothing: not Pro, no codes, no grants; the catalogue comes with its version', async () => {
  const res = await state();
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.accountToken).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.entitlement).toEqual({ pro: false, source: null, productId: null, lifetime: false, expiresAt: null, codes: [] });
  expect(body.protection).toEqual({ grants: [] });
  expect(body.catalog.version).toMatch(/^[0-9a-f]{12}$/);
  expect(body.catalog.subscription.mode).toBe('lifetime');
  expect(body.catalog.subscription.options.map((o: { productId: string }) => o.productId)).toEqual(['fitanalytica.groups.lifetime.49', 'fitanalytica.groups.lifetime.39', 'fitanalytica.groups.lifetime.29']);
  expect(body.catalog.subscription.options[0]).toMatchObject({ id: 0, kind: 'groups', billingType: 'consumable', membership: 5, isBigCard: true });
  expect(body.catalog.streak.options.map((o: { frequency: number }) => o.frequency)).toEqual([25, 50]);
  expect(body.catalog.streak.mode).toBeUndefined();
});

test('the ad rules come with the state: whole when the phone holds another version, just the version when it holds the current one; each platform has its own', async () => {
  const first = (await state()).json().ads;
  expect(first.version).toMatch(/^[0-9a-f]{12}$/);
  expect(first).toMatchObject({ enabled: true, rolloutPercent: 100, graceDays: 1, fullScreen: { minGapSeconds: 300, maxPerSession: 3 } });
  expect(first.events.activity_recorded).toEqual({ enabled: true, format: 'interstitial', maxPerDay: 3, cooldownSeconds: 3600 });
  expect(first.placements.feed_inline).toMatchObject({ enabled: false, every: 4 });
  expect((await state(`?ads=${first.version}`)).json().ads).toEqual({ version: first.version });
  expect((await state('?ads=000000000000')).json().ads.events).toBeDefined();
  expect((await state('?platform=android')).json().ads.version).toMatch(/^[0-9a-f]{12}$/);
  expect((await state('?ads=nope')).statusCode).toBe(400);
  expect((await state('?platform=web')).statusCode).toBe(400);
});

test('the account token for purchases: none before a profile; made once for a profile that has none, then the same; a new profile gets one when it is made', async () => {
  expect((await state('', noProfile.phoneToken)).json().accountToken).toBeNull();
  const first = (await state()).json().accountToken;
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect((await state()).json().accountToken).toBe(first);
  expect((await state('', b.phoneToken)).json().accountToken).toBe((await app.pg.writer.query('SELECT store_id FROM userinfo WHERE userid = $1', [b.userid])).rows[0].store_id);
  const made = await phoneProfilePut(app, noProfile.phoneToken, { fname: 'Nia' });
  expect(made.statusCode).toBe(200);
  const token = (await app.pg.writer.query('SELECT store_id FROM userinfo WHERE userid = $1', [noProfile.userid])).rows[0].store_id;
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
  await phoneProfilePut(app, noProfile.phoneToken, { fname: 'Nia R' });
  expect((await state('', noProfile.phoneToken)).json().accountToken).toBe(token);
});

test('a lifetime is Pro whichever unit it was stored in (iOS milliseconds, Android seconds)', async () => {
  await member('membership', { expires: LIFETIME_MS });
  expect((await state()).json().entitlement).toMatchObject({ pro: true, source: 'own', lifetime: true, expiresAt: null, productId: 'fitanalytica.groups.lifetime.29' });
  await app.pg.writer.query('DELETE FROM membership WHERE buyer_userid = $1', [a.userid]);
  await member('membership', { expires: LIFETIME_S });
  expect((await state()).json().entitlement).toMatchObject({ pro: true, lifetime: true, expiresAt: null });
});

test('a plan that has ended is not Pro, in either unit (a millisecond value used to never expire)', async () => {
  const past = NOW() - 3600;
  await member('membership', { expires: past * 1000, product: 'plan.a' });
  expect((await state()).json().entitlement.pro).toBe(false);
  await app.pg.writer.query('DELETE FROM membership WHERE buyer_userid = $1', [a.userid]);
  await member('membership', { expires: past, product: 'plan.a' });
  expect((await state()).json().entitlement.pro).toBe(false);
});

test('a running plan is Pro with its end in seconds, whichever unit it was stored in; the later of two is taken', async () => {
  const soon = NOW() + 86400;
  await member('membership', { expires: soon * 1000, product: 'plan.ios' });
  expect((await state()).json().entitlement).toMatchObject({ pro: true, source: 'own', lifetime: false, expiresAt: soon, productId: 'plan.ios' });
  await member('membership', { expires: soon + 5000, product: 'plan.android' });
  expect((await state()).json().entitlement).toMatchObject({ expiresAt: soon + 5000, productId: 'plan.android' });
});

test('a code redeemed is Pro for the redeemer, as gifted; an expired membership beside a live one does not matter', async () => {
  await member('membership', { buyer: b.userid, code: 'ABCD-EFGH', by: a.userid, expires: LIFETIME_MS, redeemed: 1700000100 });
  await member('membership', { expires: NOW() - 10, product: 'plan.old' });
  expect((await state()).json().entitlement).toMatchObject({ pro: true, source: 'gifted', lifetime: true });
});

test('an unredeemed code gives the buyer nothing, but the buyer sees it; a seat of the pack the buyer redeemed is theirs', async () => {
  await member('membership', { code: 'AAAA-0001' });
  const e = (await state()).json().entitlement;
  expect(e.pro).toBe(false);
  expect(e.codes).toEqual([{ code: 'AAAA-0001', createdAt: 1700000000 }]);
});

test('the codes of a pack: created, shared and redeemed, with the redeemer\'s name; oldest first', async () => {
  await member('membership', { code: 'AAAA-0001', created: 1700000001 });
  await member('membership', { code: 'AAAA-0002', created: 1700000002, shared: 1700000500 });
  await member('membership', { code: 'AAAA-0003', created: 1700000003, shared: 1700000600, by: b.userid, expires: LIFETIME_MS, redeemed: 1700000900 });
  expect((await state()).json().entitlement.codes).toEqual([
    { code: 'AAAA-0001', createdAt: 1700000001 },
    { code: 'AAAA-0002', createdAt: 1700000002, sharedAt: 1700000500 },
    { code: 'AAAA-0003', createdAt: 1700000003, sharedAt: 1700000600, activatedAt: 1700000900, firstName: 'Pat', lastName: 'Test' },
  ]);
});

test('sandbox rows count only when BILLING_ENV says so', async () => {
  await member('membership_sandbox', { expires: LIFETIME_MS });
  expect((await state()).json().entitlement.pro).toBe(false);
  process.env.BILLING_ENV = 'both';
  expect((await state()).json().entitlement.pro).toBe(true);
  process.env.BILLING_ENV = 'sandbox';
  expect((await state()).json().entitlement.pro).toBe(true);
  await member('membership', { buyer: b.userid, expires: LIFETIME_MS });
  expect((await state('', b.phoneToken)).json().entitlement.pro).toBe(false);
});

test('bought protection days: purchases only (not days spent, not ones tied to a streak), oldest first', async () => {
  const q = (days: number, type: string, ddate: number, tx: number | null, streak: string | null = null) =>
    app.pg.writer.query('INSERT INTO protection_logs (userid, protection_days, transaction_type, ddate, transaction_id, streak_id) VALUES ($1, $2, $3, $4, $5, $6)', [a.userid, days, type, ddate, tx, streak]);
  await q(50, 'iap', 1700000200, 9000000000001);
  await q(25, 'iap', 1700000100, 9000000000002);
  await q(3, 'used', 1700000300, null);
  await q(10, 'iap', 1700000400, 9000000000003, randomUUID());
  await q(25, 'iap', 1700000100, 9000000000004, null).catch(() => {});
  const grants = (await state()).json().protection.grants as { id: string; days: number; at: number }[];
  expect(grants.map((g) => [g.days, g.at])).toEqual([[25, 1700000100], [25, 1700000100], [50, 1700000200]]);
  for (const g of grants) expect(g.id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await state('', b.phoneToken)).json().protection.grants).toEqual([]);
});

test('the catalogue: sent whole when the phone holds another version, only its version when it holds this one', async () => {
  const first = (await state()).json().catalog;
  const same = (await state(`?catalog=${first.version}`)).json().catalog;
  expect(same).toEqual({ version: first.version });
  const other = (await state('?catalog=000000000000')).json().catalog;
  expect(other.subscription.options).toHaveLength(3);
  expect((await state('?catalog=not-a-version')).statusCode).toBe(400);
});

test('a plan put on sale switches the mode; taking a product off sale removes it and changes the version', () => {
  const data = structuredClone(CATALOG_DATA) as CatalogData;
  const before = buildCatalog(data);
  expect(before.subscription.mode).toBe('lifetime');
  data.subscription.products.push({ productId: 'test.plan.yearly', kind: 'subscription', billingType: 'subscription', display: { title: 'YEARLY' } });
  const on = buildCatalog(data);
  expect(on.subscription.mode).toBe('subscription');
  expect(on.subscription.options.at(-1)).toMatchObject({ id: 3, productId: 'test.plan.yearly', kind: 'subscription', billingType: 'subscription', title: 'YEARLY' });
  expect(on.version).not.toBe(before.version);
  data.subscription.products.at(-1)!.active = false;
  const off = buildCatalog(data);
  expect(off.subscription.mode).toBe('lifetime');
  expect(off.version).toBe(before.version);
});

test('a product is found by its store id, also when it is off sale (a purchase made before must be recognised); an unknown id is not found', () => {
  expect(findProduct('fitanalytica.streak.29')).toMatchObject({ kind: 'streak', frequency: 50 });
  const off = structuredClone(CATALOG_DATA) as CatalogData;
  off.streak.products[0].active = false;
  expect(buildCatalog(off).streak.options.map((o) => o.productId)).toEqual(['fitanalytica.streak.29']);
  expect(findProduct('fitanalytica.streak.19')).toBeDefined();
  expect(findProduct('nope')).toBeUndefined();
});

test('no token is refused, and a watch token too (phone only)', async () => {
  const none = await phoneState(app, null);
  expect(none.statusCode).toBe(400);
  expect(none.json().code).toBe('INVALID_TOKEN_FORMAT');
  expect((await phoneState(app, a.watchToken)).statusCode).toBe(403);
});
