import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { ProductData } from './catalogData.js';
import { EXPIRES_S, LIFETIME_S } from './membershipSql.js';
import type { StoreRenewal, StoreTransaction } from './types.js';

// docs/data/api.md section 15. What a purchase does, in ONE place used by the phone's call and by the store's notification (before, each had its own copy). It is safe to run any number
// of times for the same purchase (a retry, the phone and the notification both reporting it): the payment row, the protection days and the membership are each keyed by the purchase, and
// a lock on the original transaction keeps two at the same moment from both making codes. The rows are the old app's, in the live or the sandbox table by the purchase's own environment.
export const TABLES = {
  production: { payments: 'payments', membership: 'membership' },
  sandbox: { payments: 'payments_sandbox', membership: 'membership_sandbox' },
} as const;

const MS_LIFETIME = 9999999999999;
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const part = () => Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
/** `ABCD-EFGH`: a code that gives a lifetime, so it comes from a secure source (not Math.random). */
export const newInviteCode = () => `${part()}-${part()}`;

export interface GrantOptions {
  /** The renewal's details, from a notification. */
  renewal?: StoreRenewal;
  /** Units of the purchase's currency per US dollar (`exchangeRate`), fetched by the caller before this starts. */
  convertRate?: number;
}

export interface GrantResult {
  /** The payment row's id: the same for every report of the same purchase. */
  paymentId: string;
}

export async function grantPurchase(
  app: FastifyInstance,
  userid: string,
  tx: StoreTransaction,
  product: ProductData | undefined,
  options: GrantOptions = {},
): Promise<GrantResult> {
  const t = TABLES[tx.environment];
  const c = await app.pg.writer.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase:${tx.originalTransactionId}`]);
    const paymentId = await savePayment(c, t.payments, userid, tx, options);
    if (product) await apply(c, t.membership, userid, tx, product);
    await c.query('COMMIT');
    return { paymentId };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Written as the old code wrote it (amount is the store's own number, in thousandths for Apple), so the rows of both stay alike.
async function savePayment(c: PoolClient, table: string, userid: string, tx: StoreTransaction, { renewal, convertRate }: GrantOptions): Promise<string> {
  const r = await c.query<{ paymentsid: string }>(
    `INSERT INTO ${table} (paymentsid, store_id, userid, amount, convert_rate, expires_date, original_purchase_date, original_transaction_id, purchase_date, transaction_id,
                           recent_subscription_start_date, subscription_group_identifier, auto_renew_status, currency, storefront, product_id,
                           in_app_ownership_type, transaction_reason, transaction_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (transaction_id) DO UPDATE SET
       userid = COALESCE(${table}.userid, EXCLUDED.userid),
       store_id = COALESCE(${table}.store_id, EXCLUDED.store_id),
       convert_rate = COALESCE(${table}.convert_rate, EXCLUDED.convert_rate),
       expires_date = EXCLUDED.expires_date,
       auto_renew_status = COALESCE(EXCLUDED.auto_renew_status, ${table}.auto_renew_status),
       recent_subscription_start_date = COALESCE(EXCLUDED.recent_subscription_start_date, ${table}.recent_subscription_start_date),
       transaction_reason = COALESCE(EXCLUDED.transaction_reason, ${table}.transaction_reason)
     RETURNING paymentsid`,
    [
      randomUUID(), tx.appAccountToken ?? null, userid, tx.price ?? 0, convertRate ?? null, tx.expiresDate ?? MS_LIFETIME, tx.originalPurchaseDate ?? null, tx.originalTransactionId,
      tx.purchaseDate ?? null, tx.transactionId, renewal?.recentSubscriptionStartDate ?? null, tx.subscriptionGroupIdentifier ? Number(tx.subscriptionGroupIdentifier) : null,
      renewal?.autoRenewStatus ?? null, tx.currency ?? null, tx.storefront ?? null, tx.productId, tx.inAppOwnershipType ?? null, tx.transactionReason ?? null, tx.type ?? null,
    ],
  );
  return r.rows[0].paymentsid;
}

/** What a purchase does to the user's rights (shared with Google Play's, `grantPlayPurchase.ts`). */
export async function apply(c: PoolClient, membership: string, userid: string, tx: StoreTransaction, product: ProductData): Promise<void> {
  const seconds = tx.expiresDate ? Math.floor(tx.expiresDate / 1000) : LIFETIME_S;
  if (product.kind === 'streak') {
    await c.query(
      `INSERT INTO protection_logs (userid, protection_days, transaction_type, transaction_id) VALUES ($1, $2, 'iap', $3) ON CONFLICT (transaction_id) DO NOTHING`,
      [userid, product.frequency ?? 0, tx.transactionId],
    );
  } else if (product.kind === 'subscription') {
    // One row for the buyer's own plan, whatever its renewals: the end moves.
    await c.query(
      `INSERT INTO ${membership} (buyer_userid, reference_id, expires_date, product_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reference_id) WHERE invite_code IS NULL DO UPDATE SET expires_date = EXCLUDED.expires_date, product_id = EXCLUDED.product_id`,
      [userid, tx.originalTransactionId, seconds, tx.productId],
    );
  } else {
    await makeCodes(c, membership, userid, tx, product.membership ?? 0, seconds);
  }
}

// A pack: as many codes as it holds, one row each. The first one is redeemed for the buyer when they are not Pro yet and have no code of this pack (so buying for yourself works at
// once); a repeat makes only the codes still missing. A code that already exists (a one in a billion) is skipped and made again.
async function makeCodes(c: PoolClient, membership: string, userid: string, tx: StoreTransaction, seats: number, expires: number): Promise<void> {
  const have = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${membership} WHERE reference_id = $1 AND invite_code IS NOT NULL`, [tx.originalTransactionId]);
  let need = seats - have.rows[0].n;
  if (need <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  const pro = await c.query(
    `SELECT 1 FROM ${membership} WHERE ((buyer_userid = $1 AND invite_code IS NULL) OR redeemed_by_userid = $1) AND ${EXPIRES_S} > $2 LIMIT 1`,
    [userid, now],
  );
  let redeemOne = have.rows[0].n === 0 && pro.rowCount === 0;
  while (need > 0) {
    const values: unknown[] = [];
    const rows = Array.from({ length: need }, (_, i) => {
      const mine = redeemOne && i === 0;
      values.push(userid, newInviteCode(), tx.originalTransactionId, mine ? expires : null, mine ? userid : null, mine ? now : null, tx.productId);
      const o = i * 7;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`;
    });
    const r = await c.query(
      `INSERT INTO ${membership} (buyer_userid, invite_code, reference_id, expires_date, redeemed_by_userid, redeemed_date, product_id) VALUES ${rows.join(', ')} ON CONFLICT DO NOTHING`,
      values,
    );
    need -= r.rowCount ?? 0;
    if (r.rowCount) redeemOne = false;
  }
}
