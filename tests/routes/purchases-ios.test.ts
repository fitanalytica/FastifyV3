import { test, expect, beforeAll, afterAll, afterEach, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { setAppleVerifier } from '../../src/services/store/apple/current.js';
import { setExchangeFetcher } from '../../src/services/store/exchangeRate.js';
import { grantPurchase } from '../../src/services/store/grantPurchase.js';
import type { AppleVerifier, StoreNotification, StoreTransaction } from '../../src/services/store/types.js';
import { phoneState } from '../helpers/viaSync.js';

// A purchase made on the phone, and the App Store's notification of it (docs/data/api.md section 15). Nothing here can be signed by Apple's keys, so the checker is replaced by one that
// reads a made-up signed value; the real checker is tried only where it must refuse (a value it cannot check). What is tested is what the server does with a purchase it believes.
let app: TestApp;
let a: Account, b: Account;
const STORE_ID = randomUUID();
const uniq = () => String(9_000_000_000_000 + Math.floor(Math.random() * 900_000_000_000));

const sign = (o: unknown) => `fake.${Buffer.from(JSON.stringify(o)).toString('base64url')}.sig`;
const unsign = (s: string) => {
  const [kind, body] = s.split('.');
  if (kind !== 'fake') throw new Error('not signed by the store');
  return JSON.parse(Buffer.from(body, 'base64url').toString());
};
const fake: AppleVerifier = {
  async transaction(s) { return unsign(s) as StoreTransaction; },
  async notification(s) { return unsign(s) as StoreNotification; },
};

const tx = (over: Partial<StoreTransaction> = {}): StoreTransaction => {
  const id = uniq();
  return { environment: 'production', transactionId: id, originalTransactionId: id, productId: 'fitanalytica.streak.19', purchaseDate: 1700000000000, price: 19990, currency: 'USD', storefront: 'USA', type: 'Consumable', ...over };
};
const buy = (t: StoreTransaction, token = a.phoneToken) => app.inject({ method: 'POST', url: '/phone/v3/purchases/ios', headers: bearer(token), payload: { signedTransaction: sign(t) } });
const notify = (n: Partial<StoreNotification> & { type: string }, raw?: string) =>
  app.inject({ method: 'POST', url: '/store/v3/appstore', payload: { signedPayload: raw ?? sign({ uuid: randomUUID(), environment: 'production', ...n }) } });
const rows = async (sql: string, p: unknown[]) => (await app.pg.writer.query(sql, p)).rows;

const made: string[] = [];
beforeAll(async () => {
  app = await build();
  [a, b] = [await createAccount(app), await createAccount(app)];
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered, store_id) VALUES ($1, 'Pat', 'Test', 68, 0, false, 'Pune', 'MH', 'IN', 1700000000, $2)`, [a.userid, STORE_ID]);
});
beforeAll(() => {
  setAppleVerifier(fake);
  setExchangeFetcher(async () => ({ inr: 83.1234, eur: 0.92 }));
});
afterEach(async () => {
  delete process.env.BILLING_ENV;
  for (const t of ['membership', 'membership_sandbox']) await app.pg.writer.query(`DELETE FROM ${t} WHERE buyer_userid = ANY($1) OR redeemed_by_userid = ANY($1)`, [[a.userid, b.userid]]);
  await app.pg.writer.query('DELETE FROM protection_logs WHERE userid = ANY($1)', [[a.userid, b.userid]]);
  for (const t of ['payments', 'payments_sandbox']) await app.pg.writer.query(`DELETE FROM ${t} WHERE userid = ANY($1) OR transaction_id::text = ANY($2)`, [[a.userid, b.userid], made]);
  for (const t of ['receiptdump', 'receiptdump_sandbox']) await app.pg.writer.query(`DELETE FROM ${t} WHERE transaction_id::text = ANY($1) OR store_id = $2`, [made, STORE_ID]);
  made.length = 0;
});
afterAll(async () => {
  setAppleVerifier();
  setExchangeFetcher();
  for (const x of [a, b]) await x.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  await app.close();
});
const track = (t: StoreTransaction) => { made.push(t.transactionId); return t; };

describe('the phone reports a purchase', () => {
  test('protection days: recorded once however often it is reported; the days are in the answer', async () => {
    const t = track(tx());
    const first = await buy(t);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.purchase).toMatchObject({ productId: 'fitanalytica.streak.19', kind: 'streak', alert: { title: '+25 Protection Days' } });
    expect(body.protection.grants.map((g: { days: number }) => g.days)).toEqual([25]);
    const again = (await buy(t)).json();
    expect(again.purchase.id).toBe(body.purchase.id);
    expect(again.protection.grants).toHaveLength(1);
    expect(await rows('SELECT userid, amount, expires_date FROM payments WHERE transaction_id = $1', [t.transactionId])).toEqual([{ userid: a.userid, amount: 19990, expires_date: '9999999999999' }]);
    expect(await rows('SELECT count(*)::int AS n FROM protection_logs WHERE transaction_id = $1', [t.transactionId])).toEqual([{ n: 1 }]);
  });

  test('the exchange rate of the purchase\'s currency is stored (units per dollar, 2 decimals); 1 for dollars and for a currency not on the list', async () => {
    const [inr, usd, odd] = [track(tx({ currency: 'INR' })), track(tx()), track(tx({ currency: 'XYZ' }))];
    for (const t of [inr, usd, odd]) await buy(t);
    const rate = async (t: StoreTransaction) => (await rows('SELECT convert_rate FROM payments WHERE transaction_id = $1', [t.transactionId]))[0].convert_rate;
    expect([await rate(inr), await rate(usd), await rate(odd)]).toEqual([83.12, 1, 1]);
  });

  test('a pack of five by someone not yet Pro: five codes, the first is theirs at once; a repeat makes no more', async () => {
    const t = track(tx({ productId: 'fitanalytica.groups.lifetime.49' }));
    const res = await buy(t);
    expect(res.statusCode).toBe(200);
    const { entitlement } = res.json();
    expect(entitlement).toMatchObject({ pro: true, source: 'own', lifetime: true, expiresAt: null });
    expect(entitlement.codes).toHaveLength(5);
    expect(entitlement.codes.filter((c: { activatedAt?: number }) => c.activatedAt)).toHaveLength(1);
    for (const c of entitlement.codes) expect(c.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect((await buy(t)).json().entitlement.codes).toHaveLength(5);
  });

  test('the same purchase reported twice at the same moment still makes five codes, not ten', async () => {
    const t = track(tx({ productId: 'fitanalytica.groups.lifetime.49' }));
    const [x, y] = await Promise.all([buy(t), buy(t)]);
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    expect(await rows('SELECT count(*)::int AS n FROM membership WHERE buyer_userid = $1 AND invite_code IS NOT NULL', [a.userid])).toEqual([{ n: 5 }]);
  });

  test('a user who is already Pro keeps all the codes of a new pack to give away', async () => {
    await buy(track(tx({ productId: 'fitanalytica.groups.lifetime.29' })));
    const res = await buy(track(tx({ productId: 'fitanalytica.groups.lifetime.39' })));
    const codes = res.json().entitlement.codes as { activatedAt?: number }[];
    expect(codes).toHaveLength(3);
    expect(codes.filter((c) => c.activatedAt)).toHaveLength(1);
  });

  test('a single membership: one code, theirs', async () => {
    const { entitlement } = (await buy(track(tx({ productId: 'fitanalytica.groups.lifetime.29' })))).json();
    expect(entitlement.pro).toBe(true);
    expect(entitlement.codes).toHaveLength(1);
    expect(entitlement.codes[0].activatedAt).toBeGreaterThan(0);
  });

  test('a TestFlight or review purchase goes to the sandbox tables, and counts only where BILLING_ENV reads them', async () => {
    const t = track(tx({ environment: 'sandbox', productId: 'fitanalytica.streak.29' }));
    const t2 = track(tx({ environment: 'sandbox', productId: 'fitanalytica.groups.lifetime.29' }));
    expect((await buy(t)).statusCode).toBe(200);
    const res = await buy(t2);
    expect(res.json().entitlement.pro).toBe(false);
    expect(await rows('SELECT count(*)::int AS n FROM payments WHERE transaction_id = ANY($1::bigint[])', [[t.transactionId, t2.transactionId]])).toEqual([{ n: 0 }]);
    expect(await rows('SELECT count(*)::int AS n FROM payments_sandbox WHERE transaction_id = ANY($1::bigint[])', [[t.transactionId, t2.transactionId]])).toEqual([{ n: 2 }]);
    expect(await rows('SELECT count(*)::int AS n FROM membership_sandbox WHERE buyer_userid = $1', [a.userid])).toEqual([{ n: 1 }]);
    process.env.BILLING_ENV = 'both';
    expect((await phoneState(app, a.phoneToken)).json().entitlement.pro).toBe(true);
  });

  test('a product that is not for sale is recorded, grants nothing and is refused', async () => {
    const t = track(tx({ productId: 'fitanalytica.something.else' }));
    const res = await buy(t);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PURCHASE_REFUSED');
    expect(await rows('SELECT count(*)::int AS n FROM payments WHERE transaction_id = $1', [t.transactionId])).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*)::int AS n FROM protection_logs WHERE userid = $1', [a.userid])).toEqual([{ n: 0 }]);
  });

  test('a value the store did not sign is refused and nothing is recorded', async () => {
    const res = await app.inject({ method: 'POST', url: '/phone/v3/purchases/ios', headers: bearer(a.phoneToken), payload: { signedTransaction: 'forged.value.here-it-is-long-enough' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PURCHASE_REFUSED');
    expect((await app.inject({ method: 'POST', url: '/phone/v3/purchases/ios', headers: bearer(a.phoneToken), payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/phone/v3/purchases/ios', payload: { signedTransaction: sign(tx()) } })).statusCode).toBe(400);
  });

  test('the real checker: a malformed value, an unsigned sandbox one and a production one with no app id are refused, never believed', async () => {
    setAppleVerifier();
    try {
      const jwt = (claim: object) => `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.c2ln`;
      const post = (v: string) => app.inject({ method: 'POST', url: '/phone/v3/purchases/ios', headers: bearer(a.phoneToken), payload: { signedTransaction: v } });
      expect((await post('not-a-jwt-at-all-but-long-enough')).statusCode).toBe(400);
      const sandbox = await post(jwt({ environment: 'Sandbox', transactionId: '1', productId: 'fitanalytica.streak.19' }));
      expect(sandbox.statusCode).toBe(400);
      expect(sandbox.json().code).toBe('PURCHASE_REFUSED');
      const live = await post(jwt({ environment: 'Production', transactionId: '1' }));
      expect(live.statusCode).toBe(503);
      expect(live.json().code).toBe('STORE_UNAVAILABLE');
      expect(await rows('SELECT count(*)::int AS n FROM protection_logs WHERE userid = $1', [a.userid])).toEqual([{ n: 0 }]);
    } finally {
      setAppleVerifier(fake);
    }
  });
});

describe('what a plan does (no plan is on sale today)', () => {
  const plan = { productId: 'test.plan', kind: 'subscription' as const, billingType: 'subscription' as const, display: {} };
  test('one membership row for the plan whatever its renewals; its end moves; stored in seconds', async () => {
    const first = tx({ productId: 'test.plan', expiresDate: (Math.floor(Date.now() / 1000) + 86400) * 1000, type: 'Auto-Renewable Subscription' });
    const renewed = { ...first, transactionId: uniq(), expiresDate: (Math.floor(Date.now() / 1000) + 5 * 86400) * 1000 };
    track(first); track(renewed);
    await grantPurchase(app, a.userid, first, plan);
    await grantPurchase(app, a.userid, renewed, plan, { renewal: { autoRenewStatus: 1, recentSubscriptionStartDate: 1700000000000 } });
    const m = await rows('SELECT expires_date FROM membership WHERE buyer_userid = $1 AND invite_code IS NULL', [a.userid]);
    expect(m).toHaveLength(1);
    expect(Number(m[0].expires_date)).toBe(Math.floor(renewed.expiresDate / 1000));
    const state = (await phoneState(app, a.phoneToken)).json().entitlement;
    expect(state).toMatchObject({ pro: true, source: 'own', lifetime: false, expiresAt: Math.floor(renewed.expiresDate / 1000), productId: 'test.plan' });
    const pay = await rows('SELECT auto_renew_status, recent_subscription_start_date FROM payments WHERE transaction_id = $1', [renewed.transactionId]);
    expect(pay).toEqual([{ auto_renew_status: 1, recent_subscription_start_date: '1700000000000' }]);
  });
});

describe('the App Store tells us', () => {
  const state = async (token = a.phoneToken) => (await phoneState(app, token)).json();

  test('a purchase the phone never reported still counts: the user is the one whose store id the app put on it; a repeat of the same notification changes nothing', async () => {
    const t = track(tx({ appAccountToken: STORE_ID }));
    const uuid = randomUUID();
    const n = { uuid, type: 'ONE_TIME_CHARGE', transaction: t };
    expect((await notify(n)).statusCode).toBe(200);
    expect((await notify(n)).statusCode).toBe(200);
    expect((await state()).protection.grants.map((g: { days: number }) => g.days)).toEqual([25]);
    expect(await rows('SELECT count(*)::int AS n FROM receiptdump WHERE receiptid = $1', [uuid])).toEqual([{ n: 1 }]);
    expect(await rows('SELECT userid FROM payments WHERE transaction_id = $1', [t.transactionId])).toEqual([{ userid: a.userid }]);
  });

  test('one the phone reported earlier is found by its original transaction, with no store id', async () => {
    const t = track(tx({ productId: 'fitanalytica.groups.lifetime.39' }));
    await buy(t);
    expect((await notify({ type: 'ONE_TIME_CHARGE', transaction: t })).statusCode).toBe(200);
    expect(await rows('SELECT count(*)::int AS n FROM membership WHERE buyer_userid = $1 AND invite_code IS NOT NULL', [a.userid])).toEqual([{ n: 2 }]);
  });

  test('a purchase of a user we do not know is kept in the dump and nothing else', async () => {
    const t = track(tx({ appAccountToken: randomUUID() }));
    expect((await notify({ type: 'ONE_TIME_CHARGE', transaction: t })).statusCode).toBe(200);
    expect(await rows('SELECT count(*)::int AS n FROM receiptdump WHERE transaction_id = $1', [t.transactionId])).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*)::int AS n FROM payments WHERE transaction_id = $1', [t.transactionId])).toEqual([{ n: 0 }]);
  });

  test('a refund is kept and grants nothing; a notice with no purchase in it (a test one) is fine', async () => {
    const t = track(tx({ appAccountToken: STORE_ID }));
    expect((await notify({ type: 'REFUND', transaction: t })).statusCode).toBe(200);
    expect((await notify({ type: 'TEST' })).statusCode).toBe(200);
    expect((await state()).protection.grants).toEqual([]);
    expect(await rows('SELECT count(*)::int AS n FROM receiptdump WHERE transaction_id = $1', [t.transactionId])).toEqual([{ n: 1 }]);
  });

  test('a sandbox notification goes to the sandbox tables', async () => {
    const t = track(tx({ environment: 'sandbox', appAccountToken: STORE_ID, productId: 'fitanalytica.streak.29' }));
    expect((await notify({ type: 'ONE_TIME_CHARGE', environment: 'sandbox', transaction: t })).statusCode).toBe(200);
    expect(await rows('SELECT count(*)::int AS n FROM payments_sandbox WHERE transaction_id = $1', [t.transactionId])).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*)::int AS n FROM receiptdump_sandbox WHERE transaction_id = $1', [t.transactionId])).toEqual([{ n: 1 }]);
  });

  test('a notification that is not signed by the store is refused (so the store sends it again, and a forger gets nothing)', async () => {
    const res = await notify({ type: 'ONE_TIME_CHARGE' }, 'forged.notification.that-is-long-enough');
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/store/v3/appstore', payload: {} })).statusCode).toBe(400);
  });
});
