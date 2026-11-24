import type { FastifyInstance } from 'fastify';
import { AppError, errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { currentPlay } from './google/current.js';
import { PlayError } from './google/types.js';
import { findProduct } from './getCatalog.js';
import { getEntitlement } from './getEntitlement.js';
import { getGrants } from './getGrants.js';
import { exchangeRate } from './exchangeRate.js';
import { baseOrderId, grantPlayPurchase, type PlayGrant } from './grantPlayPurchase.js';
import type { PurchaseResult } from './purchaseIos.js';

// docs/data/api.md section 15. The phone reports a Google Play purchase: the product and the purchase token. Nothing else it says is believed: the server asks Google Play about the token itself,
// and the purchase is recorded and granted (`grantPlayPurchase`) only when Play says it was paid, for a product that is on our list, with the user's own store id on it. Then the purchase is
// acknowledged (a plan) or consumed (a pack or protection days, so they can be bought again): Play refunds a purchase not acknowledged within 3 days. That step comes AFTER the grant and
// never fails the call (a retry does it): the user has what they paid for either way.
export interface PurchaseAndroidInput {
  productId: string;
  purchaseToken: string;
  price?: number;
  currency?: string;
}

const refused = (message: string) => errors.BadRequest(message, ErrorCode.PURCHASE_REFUSED);

/** Play's `PlayError` as ours: a token Play does not know is a refused purchase; our own access to Play being wrong is "not set up"; anything else is a failure to try again. */
export function fromPlayError(e: unknown): never {
  if (e instanceof AppError) throw e;
  if (e instanceof PlayError) {
    if (e.status === 400 || e.status === 404 || e.status === 410) throw refused('Google Play does not know this purchase');
    if (e.status === 401 || e.status === 403) throw errors.Unavailable('Google Play purchases are not set up (the server has no access)', ErrorCode.STORE_UNAVAILABLE);
    throw errors.BadGateway('Google Play could not be reached');
  }
  throw e;
}

/** Consumes a consumable (it can be bought again; this acknowledges it too) or acknowledges a one-time product, and says so in the payment row. Nothing to do when Play already shows it consumed. */
export async function finishProduct(app: FastifyInstance, productId: string, consumable: boolean, token: string, p: { orderId: string; consumptionState: number; acknowledgementState: number }): Promise<void> {
  if (p.consumptionState === 1) return;
  const play = currentPlay();
  if (consumable) await play.consumeProduct(productId, token);
  else if (p.acknowledgementState === 0) await play.acknowledgeProduct(productId, token);
  await app.pg.writer.query(`UPDATE paymentstore SET transaction_reason = $2, transaction_type = 'ACKNOWLEDGED' WHERE order_id = $1`, [p.orderId, consumable ? 'CONSUMED' : 'YET_TO_BE_CONSUMED']);
}

export async function purchaseAndroid(app: FastifyInstance, userid: string, input: PurchaseAndroidInput): Promise<PurchaseResult> {
  const product = findProduct(input.productId);
  if (!product) throw refused('That product is not for sale here');
  const play = currentPlay();
  const mine = await app.pg.writer.query<{ store_id: string | null }>('SELECT store_id FROM userinfo WHERE userid = $1', [userid]);
  const storeId = mine.rows[0]?.store_id ?? undefined;
  let grant: PlayGrant;
  let after: () => Promise<void>;
  try {
    if (product.billingType === 'subscription') {
      const s = await play.subscription(input.purchaseToken);
      if (s.productId !== product.productId || !s.latestOrderId || !s.expiryTimeMillis) throw refused('Google Play does not know this purchase');
      grant = { environment: s.test ? 'sandbox' : 'production', orderId: s.latestOrderId, productId: product.productId, appAccountToken: s.obfuscatedAccountId, expiresDate: s.expiryTimeMillis, startDate: s.startTimeMillis, regionCode: s.regionCode, autoRenewStatus: s.state, transactionReason: s.state, transactionType: s.acknowledged ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_STATE_PENDING' };
      after = async () => { if (!s.acknowledged) await play.acknowledgeSubscription(product.productId, input.purchaseToken); };
    } else {
      const p = await play.product(product.productId, input.purchaseToken);
      if (p.purchaseState === 2) throw errors.Conflict('This purchase is not paid yet', ErrorCode.PURCHASE_REFUSED);
      if (p.purchaseState !== 0 || !p.orderId) throw refused('This purchase was not completed');
      grant = { environment: p.test ? 'sandbox' : 'production', orderId: p.orderId, productId: product.productId, appAccountToken: p.obfuscatedAccountId, startDate: p.purchaseTimeMillis, regionCode: p.regionCode, autoRenewStatus: 'PURCHASED', transactionReason: p.consumptionState === 1 ? 'CONSUMED' : 'YET_TO_BE_CONSUMED', transactionType: p.acknowledgementState === 1 ? 'ACKNOWLEDGED' : 'YET_TO_BE_ACKNOWLEDGED' };
      after = () => finishProduct(app, product.productId, product.billingType === 'consumable', input.purchaseToken, p);
    }
  } catch (e) {
    fromPlayError(e);
  }
  // The purchase must carry this user's own store id (the app puts it on every purchase): a token from someone else's phone is not this user's.
  if (grant.appAccountToken && grant.appAccountToken !== storeId) throw refused('This purchase was made for another account');
  grant.amount = input.price;
  grant.currency = input.currency;
  await grantPlayPurchase(app, userid, grant, product, await exchangeRate(input.currency));
  await after().catch((e) => app.log.warn({ err: e, orderId: grant.orderId }, 'Google Play purchase granted, but it could not be acknowledged or consumed yet (the next report does it)'));
  const [entitlement, grants] = await Promise.all([getEntitlement(app, userid, app.pg.writer), getGrants(app, userid, app.pg.writer)]);
  return { purchase: { id: baseOrderId(grant.orderId), productId: product.productId, kind: product.kind, alert: product.display.alert ?? null }, entitlement, protection: { grants } };
}
