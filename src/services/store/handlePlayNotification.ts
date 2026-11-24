import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { env } from '../../config/env.js';
import { currentPlay, currentPlayNotifyAuth } from './google/current.js';
import { PlayError, type PlayNotification } from './google/types.js';
import { findProduct } from './getCatalog.js';
import { exchangeRate } from './exchangeRate.js';
import { finishProduct } from './purchaseAndroid.js';
import { baseOrderId, grantPlayPurchase, type PlayGrant } from './grantPlayPurchase.js';
import { TABLES } from './grantPurchase.js';
import type { StoreEnvironment } from './types.js';

// docs/data/api.md section 15. Google Play tells us about a purchase (real-time developer notifications, pushed by Pub/Sub). The push's own token is checked (`google/auth.ts`), the notification is
// kept (`receiptdumpstore`), and for a purchase or a plan's change the server asks Play for the current truth about the token and applies it the same way the phone's report does
// (`grantPlayPurchase`), so a purchase counts even when the phone never reported it, and a plan's renewal moves its end. The user is the one the purchase already belongs to (the plan's membership
// row, or a payment of the same order), else the one whose `store_id` the app put on it. A refund (voided purchase) is only kept for now: nothing is taken back yet. Answers: 200 when done or when
// nothing more can be done (a purchase of nobody we know: it is kept); an error when Play could not be asked, so Pub/Sub sends it again.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONE_TIME_PURCHASED = 1;

/** A stable uuid for a Pub/Sub message id, so a message delivered twice is kept once. */
const dumpId = (messageId?: string) => {
  if (!messageId) return randomUUID();
  const h = createHash('sha1').update(`play:${messageId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export async function handlePlayNotification(app: FastifyInstance, authorization: string | undefined, body: { message: { data: string; messageId?: string } }): Promise<void> {
  await currentPlayNotifyAuth().verify(authorization);
  let n: PlayNotification;
  try {
    n = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8'));
  } catch {
    throw errors.BadRequest('The notification could not be read');
  }
  if (n.packageName && n.packageName !== env().play.packageName) throw errors.BadRequest('Not a notification for this app');
  const play = currentPlay();
  let receipt: unknown;
  try {
    if (n.subscriptionNotification) {
      const { purchaseToken, subscriptionId } = n.subscriptionNotification;
      const s = await play.subscription(purchaseToken);
      receipt = s;
      await applySubscription(app, s, subscriptionId, purchaseToken);
    } else if (n.oneTimeProductNotification) {
      const { purchaseToken, sku, notificationType } = n.oneTimeProductNotification;
      const p = await play.product(sku, purchaseToken);
      receipt = p;
      if (notificationType === ONE_TIME_PURCHASED && p.purchaseState === 0) await applyProduct(app, p, sku, purchaseToken);
    }
  } catch (e) {
    // Play does not know the token (a test one, or gone): nothing to apply, and asking again would not help. Anything else is tried again.
    if (!(e instanceof PlayError && (e.status === 400 || e.status === 404 || e.status === 410))) {
      if (e instanceof AppError) throw e;
      if (e instanceof PlayError) throw errors.BadGateway('Google Play could not be reached');
      throw e;
    }
  }
  const key = n.subscriptionNotification ?? n.oneTimeProductNotification ?? n.voidedPurchaseNotification;
  if (key || n.testNotification) {
    await app.pg.writer.query(
      `INSERT INTO receiptdumpstore (receipt_id, server, transaction_id, product_id, notification, playstore_receipt) VALUES ($1, 'google', $2, $3, $4, $5) ON CONFLICT (receipt_id) DO NOTHING`,
      [
        dumpId(body.message.messageId), key?.purchaseToken ?? 'google_test_notification',
        n.subscriptionNotification?.subscriptionId ?? n.oneTimeProductNotification?.sku ?? n.voidedPurchaseNotification?.orderId ?? 'fitanalytica.test',
        JSON.stringify(n), receipt === undefined ? null : JSON.stringify(receipt),
      ],
    );
  }
}

type Subscription = Awaited<ReturnType<ReturnType<typeof currentPlay>['subscription']>>;
type Product = Awaited<ReturnType<ReturnType<typeof currentPlay>['product']>>;

async function applySubscription(app: FastifyInstance, s: Subscription, subscriptionId: string, token: string): Promise<void> {
  const product = findProduct(subscriptionId);
  if (!product || product.billingType !== 'subscription' || !s.latestOrderId || !s.expiryTimeMillis) return;
  const environment: StoreEnvironment = s.test ? 'sandbox' : 'production';
  const userid = await whose(app, environment, baseOrderId(s.latestOrderId), s.obfuscatedAccountId);
  if (!userid) {
    app.log.warn({ order: baseOrderId(s.latestOrderId) }, 'Play notification for a plan with no known user (kept in the dump)');
    return;
  }
  const last = await app.pg.writer.query<{ amount: number | null; currency: string | null }>(
    `SELECT amount, currency FROM paymentstore WHERE order_id = $1 OR order_id LIKE $2 ORDER BY ddate DESC LIMIT 1`, [baseOrderId(s.latestOrderId), `${baseOrderId(s.latestOrderId)}..%`]);
  const grant: PlayGrant = {
    environment, orderId: s.latestOrderId, productId: product.productId, appAccountToken: s.obfuscatedAccountId, expiresDate: s.expiryTimeMillis, startDate: s.startTimeMillis, regionCode: s.regionCode,
    amount: last.rows[0]?.amount ?? undefined, currency: last.rows[0]?.currency ?? undefined, autoRenewStatus: s.state, transactionReason: s.state, transactionType: s.acknowledged ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_STATE_PENDING',
  };
  await grantPlayPurchase(app, userid, grant, product, await exchangeRate(grant.currency));
  if (!s.acknowledged) await currentPlay().acknowledgeSubscription(product.productId, token).catch((e) => app.log.warn({ err: e }, 'could not acknowledge the plan yet'));
}

async function applyProduct(app: FastifyInstance, p: Product, sku: string, token: string): Promise<void> {
  const product = findProduct(sku);
  if (!product || product.billingType === 'subscription' || !p.orderId) return;
  const environment: StoreEnvironment = p.test ? 'sandbox' : 'production';
  const userid = await whose(app, environment, p.orderId, p.obfuscatedAccountId);
  if (!userid) {
    app.log.warn({ order: p.orderId }, 'Play notification for a purchase with no known user (kept in the dump)');
    return;
  }
  const known = await app.pg.writer.query<{ amount: number | null; currency: string | null }>('SELECT amount, currency FROM paymentstore WHERE order_id = $1', [p.orderId]);
  const grant: PlayGrant = {
    environment, orderId: p.orderId, productId: product.productId, appAccountToken: p.obfuscatedAccountId, startDate: p.purchaseTimeMillis, regionCode: p.regionCode, amount: known.rows[0]?.amount ?? undefined,
    currency: known.rows[0]?.currency ?? undefined, autoRenewStatus: 'PURCHASED', transactionReason: p.consumptionState === 1 ? 'CONSUMED' : 'YET_TO_BE_CONSUMED', transactionType: p.acknowledgementState === 1 ? 'ACKNOWLEDGED' : 'YET_TO_BE_ACKNOWLEDGED',
  };
  await grantPlayPurchase(app, userid, grant, product, await exchangeRate(grant.currency));
  await finishProduct(app, product.productId, product.billingType === 'consumable', token, p).catch((e) => app.log.warn({ err: e }, 'could not consume the purchase yet'));
}

/** Whose a purchase is: the plan's buyer or a payment of the same order, else the user whose store id the app put on it. */
async function whose(app: FastifyInstance, environment: StoreEnvironment, base: string, token?: string): Promise<string | undefined> {
  const m = await app.pg.writer.query<{ buyer_userid: string }>(`SELECT buyer_userid FROM ${TABLES[environment].membership} WHERE reference_id = $1 LIMIT 1`, [base]);
  if (m.rows[0]) return m.rows[0].buyer_userid;
  const p = await app.pg.writer.query<{ userid: string }>('SELECT userid FROM paymentstore WHERE (order_id = $1 OR order_id LIKE $2) AND userid IS NOT NULL ORDER BY ddate DESC LIMIT 1', [base, `${base}..%`]);
  if (p.rows[0]) return p.rows[0].userid;
  if (!token || !UUID.test(token)) return undefined;
  const u = await app.pg.writer.query<{ userid: string }>('SELECT userid FROM userinfo WHERE store_id = $1', [token]);
  return u.rows[0]?.userid;
}
