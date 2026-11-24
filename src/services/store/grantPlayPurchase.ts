import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { ProductData } from './catalogData.js';
import { TABLES, apply } from './grantPurchase.js';
import type { StoreEnvironment, StoreTransaction } from './types.js';

// docs/data/api.md section 15. What a Google Play purchase does, in ONE place used by the phone's call and by Play's notification. The rights it gives are the same as an App Store purchase's
// (`apply` in grantPurchase.ts: protection days, a plan's membership row, a pack's codes), so a purchase from either store counts the same. What differs is the payment row: Android's is the old
// app's `paymentstore` (a text order id, the end in seconds), written as the old code wrote it. Safe to run any number of times for the same purchase; a lock on the order keeps two at the same
// moment from both making codes. A purchase that already belongs to another user is refused, so a token reported by someone else gets nothing.
export interface PlayGrant {
  environment: StoreEnvironment;
  /** This period's order id (`GPA.…`, with `..0`, `..1` for a plan's renewals). */
  orderId: string;
  productId: string;
  /** The user's `store_id` that the app put on the purchase, as Google returned it. */
  appAccountToken?: string;
  /** Milliseconds; none for a purchase that never ends. */
  expiresDate?: number;
  startDate?: number;
  /** The phone's reading of what was paid (reports only). */
  amount?: number;
  currency?: string;
  regionCode?: string;
  /** The old table keeps Play's own words in these three. */
  autoRenewStatus?: string;
  transactionReason?: string;
  transactionType?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIFETIME_S = 9999999999;

/** A plan's order id without the renewal suffix: the same for every period of one subscription, so its membership is one row whose end moves. A one-time order is its own. */
export const baseOrderId = (orderId: string) => orderId.split('..')[0];

/**
 * A number for `protection_logs.transaction_id`, which is a bigint (the old Android code wrote the text order id there, which cannot work). It is derived from the order id, the same every time, and
 * **negative**, so it can never equal an App Store transaction id (those are positive).
 */
export const numericOrderId = (orderId: string): string => {
  const n = BigInt(`0x${createHash('sha256').update(orderId).digest('hex').slice(0, 14)}`); // 56 bits
  return String(-(n + 1n));
};

export async function grantPlayPurchase(app: FastifyInstance, userid: string, g: PlayGrant, product: ProductData | undefined, convertRate?: number): Promise<{ orderId: string }> {
  const base = baseOrderId(g.orderId);
  const tx: StoreTransaction = { environment: g.environment, transactionId: numericOrderId(g.orderId), originalTransactionId: base, productId: g.productId, expiresDate: g.expiresDate };
  const c = await app.pg.writer.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase:${base}`]);
    const known = await c.query<{ userid: string | null }>('SELECT userid FROM paymentstore WHERE order_id = $1', [g.orderId]);
    if (known.rows[0]?.userid && known.rows[0].userid !== userid) throw errors.Conflict('This purchase belongs to another account', ErrorCode.PURCHASE_REFUSED);
    await c.query(
      `INSERT INTO paymentstore (order_id, store_id, userid, expires_date, recent_subscription_start_date, amount, convert_rate, auto_renew_status, currency, storefront, product_id, transaction_reason, transaction_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (order_id) DO UPDATE SET
         userid = COALESCE(paymentstore.userid, EXCLUDED.userid),
         store_id = COALESCE(paymentstore.store_id, EXCLUDED.store_id),
         expires_date = EXCLUDED.expires_date,
         amount = CASE WHEN COALESCE(paymentstore.amount, 0) > 0 THEN paymentstore.amount ELSE EXCLUDED.amount END,
         convert_rate = COALESCE(paymentstore.convert_rate, EXCLUDED.convert_rate),
         auto_renew_status = EXCLUDED.auto_renew_status,
         transaction_reason = EXCLUDED.transaction_reason,
         transaction_type = EXCLUDED.transaction_type`,
      [
        g.orderId, g.appAccountToken && UUID.test(g.appAccountToken) ? g.appAccountToken : null, userid, g.expiresDate ? Math.floor(g.expiresDate / 1000) : LIFETIME_S,
        g.startDate ? Math.floor(g.startDate / 1000) : Math.floor(Date.now() / 1000), g.amount ?? 0, convertRate ?? null, g.autoRenewStatus ?? null, g.currency?.toUpperCase() ?? null,
        g.regionCode ?? null, g.productId, g.transactionReason ?? null, g.transactionType ?? null,
      ],
    );
    if (product) await apply(c, TABLES[g.environment].membership, userid, tx, product);
    await c.query('COMMIT');
    return { orderId: g.orderId };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
