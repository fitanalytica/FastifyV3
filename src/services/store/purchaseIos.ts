import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { currentVerifier } from './apple/current.js';
import { findProduct } from './getCatalog.js';
import { getEntitlement, type Entitlement } from './getEntitlement.js';
import { getGrants, type ProtectionGrant } from './getGrants.js';
import { exchangeRate } from './exchangeRate.js';
import { grantPurchase } from './grantPurchase.js';
import { AppError } from '../../errors/AppError.js';

// docs/data/api.md section 15. The phone reports a purchase it made: the transaction as the App Store signed it. The signature is checked here (nothing the phone adds is believed), the
// purchase is recorded and granted (`grantPurchase`), and the answer is the user's new state, from the writer, so what was just granted is in it. A purchase of a product that is not
// on the list is recorded but granted nothing, and refused, so it is looked at by hand and never lost.
export interface PurchaseResult {
  purchase: { id: string; productId: string; kind: string; alert: unknown };
  entitlement: Entitlement;
  protection: { grants: ProtectionGrant[] };
}

export async function purchaseIos(app: FastifyInstance, userid: string, signedTransaction: string): Promise<PurchaseResult> {
  let tx;
  try {
    tx = await currentVerifier().transaction(signedTransaction);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw errors.BadRequest('The purchase could not be checked with the App Store', ErrorCode.PURCHASE_REFUSED);
  }
  const product = findProduct(tx.productId);
  const { paymentId } = await grantPurchase(app, userid, tx, product, { convertRate: await exchangeRate(tx.currency) });
  if (!product) throw errors.BadRequest('That product is not for sale here', ErrorCode.PURCHASE_REFUSED);
  const [entitlement, grants] = await Promise.all([getEntitlement(app, userid, app.pg.writer), getGrants(app, userid, app.pg.writer)]);
  return { purchase: { id: paymentId, productId: product.productId, kind: product.kind, alert: product.display.alert ?? null }, entitlement, protection: { grants } };
}
