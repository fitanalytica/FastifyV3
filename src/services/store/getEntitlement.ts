import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { EXPIRES_S, LIFETIME_S, membershipSource } from './membershipSql.js';

// docs/data/api.md section 15. What the user has: Pro or not, from their own membership (a purchase of a plan or the first seat of a pack) or one they redeemed, and the
// invite codes of the packs they bought. The membership table is the source of truth; nothing here is kept apart from it.

export interface InviteCode {
  code: string;
  /** Epoch seconds. */
  createdAt: number;
  sharedAt?: number;
  /** When someone redeemed it, and who. */
  activatedAt?: number;
  firstName?: string;
  lastName?: string;
}

export interface Entitlement {
  pro: boolean;
  /** `own`: bought (or the buyer's own seat); `gifted`: redeemed from someone's code; `null` when not Pro. */
  source: 'own' | 'gifted' | null;
  productId: string | null;
  /** A lifetime has no end: `expiresAt` is then `null`. */
  lifetime: boolean;
  /** Epoch seconds, or `null` for a lifetime or when not Pro. */
  expiresAt: number | null;
  codes: InviteCode[];
}

interface ActiveRow { buyer_userid: string; product_id: string | null; expires_s: string }
interface CodeRow { invite_code: string; created_date: string | null; shared_date: string | null; redeemed_date: string | null; fname: string | null; lname: string | null }

const num = (v: string | null) => (v === null ? undefined : Number(v));

/** `pool`: the reader (the default), or the writer right after a purchase, which the reader may not have yet. */
export async function getEntitlement(app: FastifyInstance, userid: string, pool: Pool = app.pg.reader, now: number = Math.floor(Date.now() / 1000)): Promise<Entitlement> {
  const source = membershipSource();
  const [active, codes] = await Promise.all([
    pool.query<ActiveRow>(
      `WITH m AS (${source})
       SELECT buyer_userid, product_id, ${EXPIRES_S} AS expires_s FROM m
        WHERE ((buyer_userid = $1 AND invite_code IS NULL) OR redeemed_by_userid = $1) AND ${EXPIRES_S} > $2
        ORDER BY expires_s DESC LIMIT 1`,
      [userid, now],
    ),
    pool.query<CodeRow>(
      `WITH m AS (${source})
       SELECT m.invite_code, m.created_date, m.shared_date, m.redeemed_date, u.fname, u.lname
         FROM m LEFT JOIN userinfo u ON u.userid = m.redeemed_by_userid
        WHERE m.buyer_userid = $1 AND m.invite_code IS NOT NULL
        ORDER BY m.created_date, m.invite_code`,
      [userid],
    ),
  ]);
  const row = active.rows[0];
  const lifetime = !!row && Number(row.expires_s) >= LIFETIME_S;
  return {
    pro: !!row,
    source: row ? (row.buyer_userid === userid ? 'own' : 'gifted') : null,
    productId: row?.product_id ?? null,
    lifetime,
    expiresAt: row && !lifetime ? Number(row.expires_s) : null,
    codes: codes.rows.map((r) => ({
      code: r.invite_code,
      createdAt: Number(r.created_date ?? 0),
      ...(r.shared_date ? { sharedAt: num(r.shared_date) } : {}),
      ...(r.redeemed_date ? { activatedAt: num(r.redeemed_date), firstName: (r.fname ?? '').trim(), lastName: (r.lname ?? '').trim() } : {}),
    })),
  };
}
