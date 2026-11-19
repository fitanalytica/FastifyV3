import type { FastifyInstance } from 'fastify';
import { errors, AppError } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { currentVerifier } from './apple/current.js';
import { findProduct } from './getCatalog.js';
import { exchangeRate } from './exchangeRate.js';
import { grantPurchase } from './grantPurchase.js';
import type { StoreEnvironment } from './types.js';

// docs/data/api.md section 15. The App Store tells us about a purchase (App Store Server Notifications v2): a purchase, a renewal, an expiry, a refund. Its signature is checked, the
// raw notification is kept (`receiptdump`), and the purchase is recorded and granted the same way the phone's report does (`grantPurchase`), so it counts even when the phone never
// reported it (it was closed, or offline). The user is the one whose purchase this already is (a payment with the same original transaction), else the one whose `store_id` the app put on it.
// A refund or revoke is only kept for now: nothing is taken back yet (docs/data/production-checklist.md).
const TABLES: Record<StoreEnvironment, { payments: string; dump: string }> = {
  production: { payments: 'payments', dump: 'receiptdump' },
  sandbox: { payments: 'payments_sandbox', dump: 'receiptdump_sandbox' },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAKEN_BACK = new Set(['REFUND', 'REVOKE']);

export async function handleAppStoreNotification(app: FastifyInstance, signedPayload: string): Promise<void> {
  let n;
  try {
    n = await currentVerifier().notification(signedPayload);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw errors.BadRequest('The notification could not be checked', ErrorCode.PURCHASE_REFUSED);
  }
  const t = TABLES[n.environment];
  const tx = n.transaction;
  if (n.uuid && UUID.test(n.uuid)) {
    await app.pg.writer.query(
      `INSERT INTO ${t.dump} (receiptid, store_id, receipt, transaction_id, original_transaction_id, server) VALUES ($1, $2, $3, $4, $5, 'apple') ON CONFLICT (receiptid) DO NOTHING`,
      [n.uuid, tx?.appAccountToken && UUID.test(tx.appAccountToken) ? tx.appAccountToken : null, JSON.stringify({ signedPayload }), tx?.transactionId ?? null, tx?.originalTransactionId ?? null],
    );
  }
  if (!tx || TAKEN_BACK.has(n.type)) return;
  const userid = await whose(app, t.payments, tx.originalTransactionId, tx.appAccountToken);
  if (!userid) {
    app.log.warn({ original: tx.originalTransactionId, type: n.type }, 'App Store notification for a purchase with no known user (kept in the dump)');
    return;
  }
  await grantPurchase(app, userid, tx, findProduct(tx.productId), { renewal: n.renewal, convertRate: await exchangeRate(tx.currency) });
}

async function whose(app: FastifyInstance, payments: string, original: string, token?: string): Promise<string | undefined> {
  const known = await app.pg.writer.query<{ userid: string }>(`SELECT userid FROM ${payments} WHERE original_transaction_id = $1 AND userid IS NOT NULL ORDER BY ddate DESC LIMIT 1`, [original]);
  if (known.rows[0]) return known.rows[0].userid;
  if (!token || !UUID.test(token)) return undefined;
  const mine = await app.pg.writer.query<{ userid: string }>('SELECT userid FROM userinfo WHERE store_id = $1', [token]);
  return mine.rows[0]?.userid;
}
