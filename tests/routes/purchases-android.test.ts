import { test, expect, beforeAll, afterAll, afterEach, beforeEach, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { errors } from '../../src/errors/AppError.js';
import { CATALOG_DATA, type ProductData } from '../../src/services/store/catalogData.js';
import { setExchangeFetcher } from '../../src/services/store/exchangeRate.js';
import { setPlayClient, setPlayNotifyAuth } from '../../src/services/store/google/current.js';
import { PlayError, type PlayClient, type PlayProduct, type PlaySubscription } from '../../src/services/store/google/types.js';
import { baseOrderId, numericOrderId } from '../../src/services/store/grantPlayPurchase.js';

// A Google Play purchase made on the phone, and Play's real-time notification of it (docs/data/api.md section 15). Google cannot be asked from here, so the Play client is replaced by one that
// answers from a table of made-up tokens (and records what the server did to them: acknowledged, consumed); the real one is tried only where it must say "not set up". What is tested is
// what the server does with what Play says.
let app: TestApp;
let a: Account, b: Account;
const STORE_ID = randomUUID();

const products = new Map<string, PlayProduct>();
const subscriptions = new Map<string, PlaySubscription>();
const done: string[] = [];
let failWith: PlayError | undefined;
let consumeFails = false;
const fake: PlayClient = {
  async product(_id, token) { if (failWith) throw failWith; const p = products.get(token); if (!p) throw new PlayError(404, 'no such token'); return p; },
  async subscription(token) { if (failWith) throw failWith; const s = subscriptions.get(token); if (!s) throw new PlayError(404, 'no such token'); return s; },
  async acknowledgeProduct(_id, token) { done.push(`ack:${token}`); },
  async consumeProduct(_id, token) { if (consumeFails) throw new PlayError(500, 'boom'); done.push(`consume:${token}`); },
  async acknowledgeSubscription(_id, token) { done.push(`ack-sub:${token}`); },
};

const uniq = () => `${Math.floor(Math.random() * 1e12)}`;
const order = () => `GPA.${uniq().slice(0, 4)}-${uniq().slice(0, 4)}-${uniq().slice(0, 4)}-${uniq().slice(0, 5)}`;
const token = () => `tok-${randomUUID()}`;
const product = (over: Partial<PlayProduct> = {}): PlayProduct => ({ orderId: order(), purchaseState: 0, acknowledgementState: 0, consumptionState: 0, regionCode: 'IN', obfuscatedAccountId: STORE_ID, test: false, ...over });
const put = (over: Partial<PlayProduct> = {}) => { const t = token(); const p = product(over); products.set(t, p); return { t, p }; };
const buy = (productId: string, purchaseToken: string, who = a.phoneToken, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/phone/v3/purchases/android', headers: bearer(who), payload: { productId, purchaseToken, ...extra } });
const notify = (n: object, auth = 'Bearer good', messageId = uniq()) =>
  app.inject({ method: 'POST', url: '/store/v3/playstore', headers: { authorization: auth }, payload: { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.fitanalytica', eventTimeMillis: '1700000000000', ...n })).toString('base64'), messageId } } });
const rows = async (sql: string, p: unknown[]) => (await app.pg.writer.query(sql, p)).rows;

const PLAN: ProductData = { productId: 'fitanalytica.plan.test', kind: 'subscription', billingType: 'subscription', active: false, display: { alert: { title: 'Pro' } } };
const orders: string[] = [];

beforeAll(async () => {
  app = await build();
  [a, b] = [await createAccount(app), await createAccount(app)];
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered, store_id) VALUES ($1, 'Pat', 'Test', 68, 0, false, 'Pune', 'MH', 'IN', 1700000000, $2)`, [a.userid, STORE_ID]);
  await app.pg.writer.query(`INSERT INTO userinfo (userid, fname, lname, weight, seconds_from_gmt, hideprofile, city, state, iso, dateregistered, store_id) VALUES ($1, 'Sam', 'Other', 70, 0, false, 'Pune', 'MH', 'IN', 1700000000, $2)`, [b.userid, randomUUID()]);
  CATALOG_DATA.subscription.products.push(PLAN);
  setPlayClient(fake);
  setPlayNotifyAuth({ async verify(h) { if (h !== 'Bearer good') throw errors.Unauthorized('Invalid token'); } });
  setExchangeFetcher(async () => ({ inr: 83.1234 }));
});
beforeEach(() => { failWith = undefined; consumeFails = false; });
afterEach(async () => {
  delete process.env.BILLING_ENV;
  for (const t of ['membership', 'membership_sandbox']) await app.pg.writer.query(`DELETE FROM ${t} WHERE buyer_userid = ANY($1) OR redeemed_by_userid = ANY($1)`, [[a.userid, b.userid]]);
  await app.pg.writer.query('DELETE FROM protection_logs WHERE userid = ANY($1)', [[a.userid, b.userid]]);
  await app.pg.writer.query('DELETE FROM paymentstore WHERE userid = ANY($1) OR order_id = ANY($2)', [[a.userid, b.userid], orders]);
  await app.pg.writer.query(`DELETE FROM receiptdumpstore WHERE server = 'google' AND notification::text LIKE '%"packageName":"com.fitanalytica"%'`);
  products.clear(); subscriptions.clear(); done.length = 0; orders.length = 0;
});
afterAll(async () => {
  CATALOG_DATA.subscription.products.pop();
  setPlayClient(); setPlayNotifyAuth(); setExchangeFetcher();
  for (const x of [a, b]) await x.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = ANY($1)', [[a.userid, b.userid]]);
  await app.close();
});
const track = <T extends { orderId?: string; latestOrderId?: string }>(p: T) => { orders.push((p.orderId ?? p.latestOrderId) as string); return p; };

describe('the phone reports a Play purchase', () => {
  test('protection days: checked with Play, granted once however often it is reported, then consumed; the days are in the answer', async () => {
    const { t, p } = put(); track(p);
    const first = await buy('fitanalytica.streak.19', t, a.phoneToken, { price: 19.99, currency: 'USD' });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.purchase).toMatchObject({ id: p.orderId, productId: 'fitanalytica.streak.19', kind: 'streak', alert: { title: '+25 Protection Days' } });
    expect(body.protection.grants.map((g: { days: number }) => g.days)).toEqual([25]);
    const again = (await buy('fitanalytica.streak.19', t)).json();
    expect(again.protection.grants).toHaveLength(1);
    expect(await rows('SELECT userid, expires_date, amount, auto_renew_status FROM paymentstore WHERE order_id = $1', [p.orderId])).toEqual([{ userid: a.userid, expires_date: '9999999999', amount: 19.99, auto_renew_status: 'PURCHASED' }]);
    // The days are keyed by a number made from the order id, negative so it can never be an App Store id.
    expect(await rows('SELECT transaction_id::text AS id FROM protection_logs WHERE userid = $1', [a.userid])).toEqual([{ id: numericOrderId(p.orderId) }]);
    expect(numericOrderId(p.orderId).startsWith('-')).toBe(true);
    expect(done).toContain(`consume:${t}`);
    expect(await rows('SELECT transaction_reason FROM paymentstore WHERE order_id = $1', [p.orderId])).toEqual([{ transaction_reason: 'CONSUMED' }]);
  });

  test('a pack of five: five codes, the first is theirs at once; a repeat or two at the same moment make no more', async () => {
    const { t, p } = put(); track(p);
    const [x, y] = await Promise.all([buy('fitanalytica.groups.lifetime.49', t), buy('fitanalytica.groups.lifetime.49', t)]);
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    const { entitlement } = (await buy('fitanalytica.groups.lifetime.49', t)).json();
    expect(entitlement).toMatchObject({ pro: true, source: 'own', lifetime: true });
    expect(entitlement.codes).toHaveLength(5);
    expect(entitlement.codes.filter((c: { activatedAt?: number }) => c.activatedAt)).toHaveLength(1);
  });

  test('the exchange rate is stored with the payment (units per dollar); a purchase with no currency still goes through', async () => {
    const { t, p } = put(); track(p);
    await buy('fitanalytica.streak.19', t, a.phoneToken, { price: 1599, currency: 'inr' });
    expect(await rows('SELECT convert_rate, currency FROM paymentstore WHERE order_id = $1', [p.orderId])).toEqual([{ convert_rate: 83.12, currency: 'INR' }]);
    const two = put(); track(two.p);
    expect((await buy('fitanalytica.streak.29', two.t)).statusCode).toBe(200);
  });

  test('consuming failed: the purchase is still granted (they paid), and the next report consumes it', async () => {
    const { t, p } = put(); track(p);
    consumeFails = true;
    expect((await buy('fitanalytica.streak.19', t)).statusCode).toBe(200);
    expect(done).not.toContain(`consume:${t}`);
    consumeFails = false;
    await buy('fitanalytica.streak.19', t);
    expect(done).toContain(`consume:${t}`);
    expect((await buy('fitanalytica.streak.19', t)).json().protection.grants).toHaveLength(1);
  });

  test('not paid yet (pending) is not granted; a cancelled one is refused; nothing is recorded for either', async () => {
    const pending = put({ purchaseState: 2 }); track(pending.p);
    const cancelled = put({ purchaseState: 1 }); track(cancelled.p);
    const r1 = await buy('fitanalytica.streak.19', pending.t);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().code).toBe('PURCHASE_REFUSED');
    expect((await buy('fitanalytica.streak.19', cancelled.t)).statusCode).toBe(400);
    expect(await rows('SELECT 1 FROM paymentstore WHERE userid = $1', [a.userid])).toHaveLength(0);
    expect(await rows('SELECT 1 FROM protection_logs WHERE userid = $1', [a.userid])).toHaveLength(0);
    expect(done).toEqual([]);
  });

  test('a token that carries another account\'s store id is refused: it is not theirs', async () => {
    const { t, p } = put({ obfuscatedAccountId: randomUUID() }); track(p);
    const r = await buy('fitanalytica.streak.19', t);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('PURCHASE_REFUSED');
    expect(await rows('SELECT 1 FROM paymentstore WHERE order_id = $1', [p.orderId])).toHaveLength(0);
  });

  test('a purchase already recorded for one user cannot be claimed by another (a token with no store id on it)', async () => {
    const { t, p } = put({ obfuscatedAccountId: undefined }); track(p);
    expect((await buy('fitanalytica.streak.19', t)).statusCode).toBe(200);
    const r = await buy('fitanalytica.streak.19', t, b.phoneToken);
    expect(r.statusCode).toBe(409);
    expect(await rows('SELECT 1 FROM protection_logs WHERE userid = $1', [b.userid])).toHaveLength(0);
  });

  test('a product that is not for sale, and a token Play does not know, are refused', async () => {
    const { t, p } = put(); track(p);
    expect((await buy('fitanalytica.nothing', t)).statusCode).toBe(400);
    expect((await buy('fitanalytica.streak.19', token())).statusCode).toBe(400);
  });

  test('Play refusing the server (403) is "not set up"; Play failing (500) is a bad gateway, so the phone tries again', async () => {
    const { t } = put();
    failWith = new PlayError(403, 'no access');
    expect((await buy('fitanalytica.streak.19', t)).json().code).toBe('STORE_UNAVAILABLE');
    failWith = new PlayError(500, 'down');
    expect((await buy('fitanalytica.streak.19', t)).statusCode).toBe(502);
  });

  test('a license tester\'s purchase goes to the sandbox tables and counts only where BILLING_ENV reads them', async () => {
    const { t, p } = put({ test: true }); track(p);
    process.env.BILLING_ENV = 'production';
    const r = await buy('fitanalytica.groups.lifetime.29', t);
    expect(r.statusCode).toBe(200);
    expect(r.json().entitlement.pro).toBe(false);
    expect(await rows('SELECT count(*)::int AS n FROM membership_sandbox WHERE buyer_userid = $1', [a.userid])).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*)::int AS n FROM membership WHERE buyer_userid = $1', [a.userid])).toEqual([{ n: 0 }]);
    process.env.BILLING_ENV = 'both';
    expect((await buy('fitanalytica.groups.lifetime.29', t)).json().entitlement.pro).toBe(true);
  });

  test('the real client, with no service account to ask Play with, says "not set up" and records nothing', async () => {
    setPlayClient();
    const saved = { ...process.env };
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GCE_METADATA_HOST = '127.0.0.1:1'; // no metadata server to borrow an identity from either
    process.env.NO_GCE_CHECK = 'true';
    try {
      const r = await buy('fitanalytica.streak.19', token());
      expect([503, 502]).toContain(r.statusCode);
    } finally {
      process.env = saved;
      setPlayClient(fake);
    }
    expect(await rows('SELECT 1 FROM paymentstore WHERE userid = $1', [a.userid])).toHaveLength(0);
  });
});

describe('a plan (none is on sale today: one is added for these tests)', () => {
  const sub = (over: Partial<PlaySubscription> = {}): PlaySubscription => ({ productId: PLAN.productId, latestOrderId: order(), state: 'SUBSCRIPTION_STATE_ACTIVE', startTimeMillis: 1700000000000, expiryTimeMillis: Date.now() + 30 * 86400_000, regionCode: 'IN', obfuscatedAccountId: STORE_ID, acknowledged: false, test: false, ...over });

  test('bought on the phone: one membership row keyed by the order without its renewal suffix, the end in seconds; acknowledged', async () => {
    const s = sub({ latestOrderId: `${order()}..0` }); track(s);
    const t = token(); subscriptions.set(t, s);
    const r = await buy(PLAN.productId, t);
    expect(r.statusCode).toBe(200);
    expect(r.json().entitlement).toMatchObject({ pro: true, source: 'own', lifetime: false, expiresAt: Math.floor((s.expiryTimeMillis as number) / 1000) });
    expect(await rows('SELECT reference_id, expires_date::text AS e FROM membership WHERE buyer_userid = $1', [a.userid])).toEqual([{ reference_id: baseOrderId(s.latestOrderId), e: String(Math.floor((s.expiryTimeMillis as number) / 1000)) }]);
    expect(done).toContain(`ack-sub:${t}`);
  });

  test('Play\'s notification of a renewal moves the end of the same membership (the renewal\'s order id differs only by its suffix)', async () => {
    const first = sub({ latestOrderId: `${order()}..0` }); track(first);
    const t = token(); subscriptions.set(t, first);
    await buy(PLAN.productId, t);
    const renewed = { ...first, latestOrderId: `${baseOrderId(first.latestOrderId)}..1`, expiryTimeMillis: (first.expiryTimeMillis as number) + 30 * 86400_000, acknowledged: true };
    track(renewed); subscriptions.set(t, renewed);
    expect((await notify({ subscriptionNotification: { notificationType: 2, purchaseToken: t, subscriptionId: PLAN.productId } })).statusCode).toBe(200);
    const m = await rows('SELECT expires_date::text AS e FROM membership WHERE buyer_userid = $1', [a.userid]);
    expect(m).toEqual([{ e: String(Math.floor((renewed.expiryTimeMillis as number) / 1000)) }]);
    expect(await rows('SELECT count(*)::int AS n FROM paymentstore WHERE userid = $1', [a.userid])).toEqual([{ n: 2 }]);
  });

  test('a plan that expired: its end is the past and the user is not Pro', async () => {
    const s = sub({ expiryTimeMillis: Date.now() - 86400_000, state: 'SUBSCRIPTION_STATE_EXPIRED' }); track(s);
    const t = token(); subscriptions.set(t, s);
    expect((await buy(PLAN.productId, t)).json().entitlement.pro).toBe(false);
  });
});

describe('Play tells us', () => {
  test('a purchase the phone never reported still counts: the user is the one whose store id the app put on it; a repeat changes nothing', async () => {
    const { t, p } = put(); track(p);
    const msg = { oneTimeProductNotification: { notificationType: 1, purchaseToken: t, sku: 'fitanalytica.streak.29' } };
    expect((await notify(msg)).statusCode).toBe(200);
    expect(await rows('SELECT protection_days FROM protection_logs WHERE userid = $1', [a.userid])).toEqual([{ protection_days: 50 }]);
    expect(done).toContain(`consume:${t}`);
    await notify(msg);
    expect(await rows('SELECT count(*)::int AS n FROM protection_logs WHERE userid = $1', [a.userid])).toEqual([{ n: 1 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM receiptdumpstore WHERE transaction_id = $1`, [t])).toEqual([{ n: 2 }]);
  });

  test('a message delivered twice by Pub/Sub (the same message id) is kept once', async () => {
    const { t, p } = put(); track(p);
    const msg = { oneTimeProductNotification: { notificationType: 1, purchaseToken: t, sku: 'fitanalytica.streak.19' } };
    await notify(msg, 'Bearer good', 'm-1');
    await notify(msg, 'Bearer good', 'm-1');
    expect(await rows(`SELECT count(*)::int AS n FROM receiptdumpstore WHERE transaction_id = $1`, [t])).toEqual([{ n: 1 }]);
  });

  test('one the phone reported earlier is found by its order, even with no store id on it', async () => {
    const { t, p } = put({ obfuscatedAccountId: undefined }); track(p);
    await buy('fitanalytica.streak.19', t);
    await notify({ oneTimeProductNotification: { notificationType: 1, purchaseToken: t, sku: 'fitanalytica.streak.19' } });
    expect(await rows('SELECT count(*)::int AS n FROM protection_logs WHERE userid = $1', [a.userid])).toEqual([{ n: 1 }]);
  });

  test('a purchase of someone we do not know is kept in the dump and nothing else', async () => {
    const { t, p } = put({ obfuscatedAccountId: randomUUID() }); track(p);
    expect((await notify({ oneTimeProductNotification: { notificationType: 1, purchaseToken: t, sku: 'fitanalytica.streak.19' } })).statusCode).toBe(200);
    expect(await rows('SELECT 1 FROM paymentstore WHERE order_id = $1', [p.orderId])).toHaveLength(0);
    expect(await rows('SELECT 1 FROM receiptdumpstore WHERE transaction_id = $1', [t])).toHaveLength(1);
  });

  test('a pending purchase grants nothing; a refund (voided) is only kept; a test notification is fine', async () => {
    const pending = put({ purchaseState: 2 }); track(pending.p);
    await notify({ oneTimeProductNotification: { notificationType: 1, purchaseToken: pending.t, sku: 'fitanalytica.streak.19' } });
    const refunded = put(); track(refunded.p);
    await buy('fitanalytica.streak.19', refunded.t);
    expect((await notify({ voidedPurchaseNotification: { purchaseToken: refunded.t, orderId: refunded.p.orderId, productType: 2 } })).statusCode).toBe(200);
    expect((await notify({ testNotification: { version: '1.0' } })).statusCode).toBe(200);
    expect(await rows('SELECT count(*)::int AS n FROM protection_logs WHERE userid = $1', [a.userid])).toEqual([{ n: 1 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM receiptdumpstore WHERE transaction_id = 'google_test_notification'`, [])).toEqual([{ n: 1 }]);
  });

  test('a token Play does not know is nothing to apply (200: asking again would not help); Play failing is an error, so Pub/Sub sends it again', async () => {
    expect((await notify({ oneTimeProductNotification: { notificationType: 1, purchaseToken: token(), sku: 'fitanalytica.streak.19' } })).statusCode).toBe(200);
    failWith = new PlayError(500, 'down');
    expect((await notify({ oneTimeProductNotification: { notificationType: 1, purchaseToken: token(), sku: 'fitanalytica.streak.19' } })).statusCode).toBe(502);
  });

  test('a notification without our token is refused (so a forger gets nothing); one for another app is refused; one that cannot be read is refused', async () => {
    const { t, p } = put(); track(p);
    const msg = { oneTimeProductNotification: { notificationType: 1, purchaseToken: t, sku: 'fitanalytica.streak.19' } };
    expect((await notify(msg, 'Bearer forged')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/store/v3/playstore', payload: { message: { data: Buffer.from(JSON.stringify(msg)).toString('base64') } } })).statusCode).toBe(401);
    expect((await notify({ ...msg, packageName: 'com.someone.else' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/store/v3/playstore', headers: { authorization: 'Bearer good' }, payload: { message: { data: 'bm90IGpzb24=' } } })).statusCode).toBe(400);
    expect(await rows('SELECT 1 FROM protection_logs WHERE userid = $1', [a.userid])).toHaveLength(0);
  });

  test('the real check of the push\'s token, with nothing set up, says "not set up"', async () => {
    setPlayNotifyAuth();
    try {
      expect((await notify({ testNotification: {} }, 'Bearer anything')).statusCode).toBe(503);
    } finally {
      setPlayNotifyAuth({ async verify(h) { if (h !== 'Bearer good') throw errors.Unauthorized('Invalid token'); } });
    }
  });
});
