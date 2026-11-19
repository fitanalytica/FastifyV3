import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { REDEEM_ALERT } from './catalogData.js';
import { getEntitlement, type Entitlement } from './getEntitlement.js';
import { EXPIRES_S, LIFETIME_S, membershipSource, membershipTables } from './membershipSql.js';

// docs/data/api.md section 15. Redeeming an invite code someone shared: the user gets the membership the code holds. The claim is ONE update that only succeeds while nobody has redeemed the
// code, so two people (or the same person twice) cannot both get it; a lock on the user keeps two codes from being redeemed at the same moment by someone who is not Pro yet.
export interface RedeemResult {
  redeemed: { id: string; productId: string | null; alert: unknown; /** The buyer's account token, for the phone's analytics. */ referrerStoreId: string | null };
  entitlement: Entitlement;
}

/** `ABCD-EFGH` from what was typed or linked: the dash, spaces and case do not matter. `null` when it cannot be a code. */
export function normalizeCode(raw: string): string | null {
  const c = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

interface Row { membership_id: string; buyer_userid: string; redeemed_by_userid: string | null; product_id: string | null; reference_id: string | null }

export async function redeem(app: FastifyInstance, userid: string, raw: string): Promise<RedeemResult> {
  const code = normalizeCode(raw);
  if (!code) throw errors.NotFound('Invalid invite code', ErrorCode.CODE_INVALID);
  const now = Math.floor(Date.now() / 1000);
  const c = await app.pg.writer.connect();
  let result: Omit<RedeemResult, 'entitlement'>;
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`redeem:${userid}`]);
    let table = '';
    let row: Row | undefined;
    for (const t of membershipTables()) {
      const r = await c.query<Row>(`SELECT membership_id, buyer_userid, redeemed_by_userid, product_id, reference_id FROM ${t} WHERE invite_code = $1`, [code]);
      if (r.rows[0]) { table = t; row = r.rows[0]; break; }
    }
    if (!row) throw errors.NotFound('Invalid invite code', ErrorCode.CODE_INVALID);
    if (row.redeemed_by_userid) throw errors.Conflict(row.redeemed_by_userid === userid ? 'You have redeemed this code' : 'This code has been redeemed', ErrorCode.CODE_USED);
    const pro = await c.query(`WITH m AS (${membershipSource()}) SELECT 1 FROM m WHERE ((buyer_userid = $1 AND invite_code IS NULL) OR redeemed_by_userid = $1) AND ${EXPIRES_S} > $2 LIMIT 1`, [userid, now]);
    if (pro.rowCount) throw errors.Conflict('You have an active Pro membership', ErrorCode.ALREADY_PRO);
    const expires = await expiryOf(c, table, row);
    if (expires <= now) throw errors.BadRequest('This shared membership has expired', ErrorCode.CODE_EXPIRED);
    const claimed = await c.query(`UPDATE ${table} SET redeemed_by_userid = $1, redeemed_date = $2, expires_date = $3 WHERE membership_id = $4 AND redeemed_by_userid IS NULL`, [userid, now, expires, row.membership_id]);
    if (!claimed.rowCount) throw errors.Conflict('This code has been redeemed', ErrorCode.CODE_USED);
    const buyer = await c.query<{ store_id: string | null }>('SELECT store_id FROM userinfo WHERE userid = $1', [row.buyer_userid]);
    await c.query('COMMIT');
    result = { redeemed: { id: row.membership_id, productId: row.product_id, alert: REDEEM_ALERT, referrerStoreId: buyer.rows[0]?.store_id ?? null } };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return { ...result, entitlement: await getEntitlement(app, userid, app.pg.writer) };
}

// A lifetime pack's code is a lifetime; a code of a plan ends when the buyer's plan does (its own row, same reference). Seconds. 0 when there is nothing to follow.
async function expiryOf(c: { query: (sql: string, p: unknown[]) => Promise<{ rows: { s: string }[] }> }, table: string, row: Row): Promise<number> {
  if (row.product_id?.toLowerCase().includes('lifetime')) return LIFETIME_S;
  const r = await c.query(`SELECT ${EXPIRES_S} AS s FROM ${table} WHERE reference_id = $1 AND invite_code IS NULL ORDER BY s DESC LIMIT 1`, [row.reference_id]);
  return r.rows[0] ? Number(r.rows[0].s) : 0;
}
