import type { FastifyInstance } from 'fastify';
import { streakConfig, type StreakLevel } from './streakConfig.js';

// The protection days ledger (docs/data/phone.md, "The streak"): `protection_logs` has one row per event, and **the balance is the sum of a user's `protection_days`** (the user's, not a streak's: protection never
// expires and carries from one streak to the next):
//   grant   (+n)  a level's reward: streak_id, level_id and the day it was reached (dtgraph);
//   consume (-1)  a protection day spent: streak_id, level_id and the day it covered (dtgraph);
//   iap     (+n)  a purchase (written by the store code): no streak, level or day.
// The grants and the consumes of a streak are **derived from its days**, which the phone sends and the server stores (`daily_logs`). The engine on the phone never takes a decision back (a day is decided once), so the
// events of a streak only ever grow: when a streak is stored, the events its days imply that the ledger does not have yet are **appended**, and **no row is ever removed or changed**. That makes sending a streak twice
// harmless, and it keeps the rows the old app wrote for the same streak (the old app credited and charged the users with them: they are what they have): an event that is already there, from either app, is not added
// again. **Days the server already held for the streak are settled**: nothing is derived for them (the old app's streaks come with their days and their ledger as they were, gaps included: no back payment and no
// correction), only days that are new. A purchase is never touched.

const DAY = 86_400;

export type LedgerRow = { type: 'grant' | 'consume'; levelId: string; dtgraph: number; days: number };
type Logs = { level_id: string; logs: { s?: number; p?: true; n?: true }[] }[];

/** The ledger rows of a streak, from its days: a `consume` for each protected day, and a `grant` on the day each rewarded level's duration is reached (only days that were kept count toward it). */
export function ledgerRows(startDate: number, dailyLogs: Logs, levels: StreakLevel[] = streakConfig().levels): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let valid = 0;
  let index = 0;
  for (const level of dailyLogs) {
    for (const day of level.logs) {
      const dtgraph = startDate + index * DAY;
      index += 1;
      if (day.p) {
        rows.push({ type: 'consume', levelId: level.level_id, dtgraph, days: -1 });
      } else if (!day.n) {
        valid += 1;
        for (const l of levels) {
          if (l.duration === valid && (l.reward ?? 0) > 0) {
            rows.push({ type: 'grant', levelId: l.level_id, dtgraph, days: l.reward ?? 0 });
          }
        }
      }
    }
  }
  return rows;
}

/** What makes two events the same event, whichever app wrote them: a `grant` is a level on a day; a `consume` is a day (a day is covered once, whatever level the old app thought it was in). */
export const rowKey = (type: string, levelId: string, dtgraph: number) => (type === 'grant' ? `grant|${levelId.toLowerCase()}|${dtgraph}` : `consume|${dtgraph}`);

/** How many days a stored `daily_logs` holds (all levels together): the days the server already has for a streak. 0 for a streak it has not seen (or logs it cannot read). */
export function settledDays(stored: unknown): number {
  const levels = typeof stored === 'string' ? safeParse(stored) : stored;
  return Array.isArray(levels) ? levels.reduce((t: number, l: { logs?: unknown }) => t + (Array.isArray(l?.logs) ? l.logs.length : 0), 0) : 0;
}
const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The events a streak's days imply that `existing` does not have yet. Pure. */
export function missingRows(derived: LedgerRow[], existing: { type: string; levelId: string; dtgraph: number }[]): LedgerRow[] {
  const have = new Set(existing.map(r => rowKey(r.type, r.levelId, r.dtgraph)));
  return derived.filter(r => !have.has(rowKey(r.type, r.levelId, r.dtgraph)));
}

type Client = { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }> };

const EXISTING = `SELECT transaction_type AS type, level_id, dtgraph FROM protection_logs WHERE streak_id = $1 AND userid = $2 AND transaction_type IN ('grant', 'consume')`;

/** Appends the events a streak's days imply that its ledger does not have yet (inside the caller's transaction). Nothing is removed or changed; purchases (`iap`) are never touched. */
export async function writeLedger(c: Client, userid: string, streakId: string, startDate: number, dailyLogs: Logs, settled = 0): Promise<void> {
  const have = await c.query(EXISTING, [streakId, userid]);
  const existing = (have.rows as { type: string; level_id: string | null; dtgraph: string | number | null }[]).map(r => ({ type: r.type, levelId: r.level_id ?? '', dtgraph: Number(r.dtgraph) }));
  // Only days after the ones the server already held: those are settled, whatever the ledger says of them.
  const firstNew = startDate + settled * DAY;
  const rows = missingRows(ledgerRows(startDate, dailyLogs).filter(r => r.dtgraph >= firstNew), existing);
  if (!rows.length) {
    return;
  }
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(streakId, r.levelId, userid, r.dtgraph, r.days, r.type);
    const b = i * 6;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::protection_logs_transaction_type_enum)`;
  });
  await c.query(`INSERT INTO protection_logs (streak_id, level_id, userid, dtgraph, protection_days, transaction_type) VALUES ${tuples.join(', ')}`, values);
}

/** The protection days a user has: the sum of their ledger. */
export async function protectionBalance(app: FastifyInstance, userid: string): Promise<number> {
  const r = await app.pg.reader.query<{ balance: string | null }>('SELECT sum(protection_days) AS balance FROM protection_logs WHERE userid = $1', [userid]);
  return Number(r.rows[0]?.balance ?? 0);
}
