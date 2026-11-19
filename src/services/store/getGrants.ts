import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

// docs/data/api.md section 15. The protection days the user has bought (rows of `protection_logs` of type `iap`, with no streak: a purchase, not a day spent). The phone applies each
// `id` once, so a day is never counted twice and never lost if the app was closed before the user saw the pop-up.

export interface ProtectionGrant {
  id: string;
  days: number;
  /** Epoch seconds. */
  at: number;
}

export async function getGrants(app: FastifyInstance, userid: string, pool: Pool = app.pg.reader): Promise<ProtectionGrant[]> {
  const r = await pool.query<{ protection_id: string; protection_days: number; ddate: string | null }>(
    `SELECT protection_id, protection_days, ddate FROM protection_logs
      WHERE userid = $1 AND transaction_type = 'iap' AND streak_id IS NULL
      ORDER BY ddate, protection_id LIMIT 500`,
    [userid],
  );
  return r.rows.map((g) => ({ id: g.protection_id, days: g.protection_days, at: Number(g.ddate ?? 0) }));
}
