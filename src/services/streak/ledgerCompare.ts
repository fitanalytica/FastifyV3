import { ledgerRows, missingRows, rowKey, type LedgerRow } from './ledger.js';
import type { StreakLevel } from './streakConfig.js';

// Compares what a streak's days imply for the protection ledger with the rows the ledger already has, for the dry run over the old app's data (`scripts/ledger-dry-run.ts`): how much would the server add when an old
// streak is sent again (it appends the missing events and never removes one), and how much would a rewrite from the days have changed (the old rows that no day implies would go). Pure: no database.

export type OldRow = { type: string; levelId: string; dtgraph: number; days: number };
type Logs = { level_id: string; logs: { s?: number; p?: true; n?: true }[] }[];

export type StreakComparison = {
  /** What the days imply that the ledger does not have: appended. */
  missing: LedgerRow[];
  /** Rows the ledger has that no day implies: a rewrite would have removed them; appending leaves them. */
  extra: OldRow[];
  /** The days imply the same events as the ledger has. */
  same: boolean;
  /** The balance change from appending (the missing events). */
  appendDelta: number;
  /** The balance change a rewrite from the days would have made (the missing, less the extra). */
  rewriteDelta: number;
  /** Old `consume` rows, and how many sit on a day the days mark as protected (the day labels agree). */
  consumes: { total: number; onProtectedDay: number };
};

const sum = (rows: { days: number }[]) => rows.reduce((t, r) => t + r.days, 0);

export function compareStreak(startDate: number, dailyLogs: Logs, old: OldRow[], levels?: StreakLevel[]): StreakComparison {
  const derived = ledgerRows(startDate, dailyLogs, levels);
  const missing = missingRows(derived, old);
  const wanted = new Set(derived.map(r => rowKey(r.type, r.levelId, r.dtgraph)));
  const mine = old.filter(r => r.type === 'grant' || r.type === 'consume');
  const extra = mine.filter(r => !wanted.has(rowKey(r.type, r.levelId, r.dtgraph)));
  const protectedDays = new Set(derived.filter(r => r.type === 'consume').map(r => r.dtgraph));
  const consumes = mine.filter(r => r.type === 'consume');
  return {
    missing,
    extra,
    same: missing.length === 0 && extra.length === 0,
    appendDelta: sum(missing),
    rewriteDelta: sum(missing) - sum(extra),
    consumes: { total: consumes.length, onProtectedDay: consumes.filter(r => protectedDays.has(r.dtgraph)).length },
  };
}
