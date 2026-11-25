// Dry run of the protection ledger over the old app's data (docs/data/sync.md section 4g, docs/data/production-checklist.md "Protection ledger"). It reads two exports (CSV with a header row, as `psql \copy` or a
// client's export gives: `streak_logs` and `protection_logs`), works out for every streak what its days imply for the ledger, and reports how that compares with the rows the old app wrote:
//   - the events the days imply that the ledger LACKS (rewards the old app never paid): the server does NOT credit them: days it already holds for a streak are settled, and only new days make events;
//   - the rows the ledger has that no day implies (charges for a day that was lifted later): the server leaves them, it never removes a row; a REWRITE from the days would have removed (refunded) them;
//   - whether the day labels agree: an old `consume` row should sit on a day the days mark as protected.
// It touches no database and prints counts and sums only: no user id, no name. With `--details` it also lists the streaks that differ, by the first 8 characters of their id.
//
//   npx tsx scripts/ledger-dry-run.ts streak_logs.csv protection_logs.csv [--details]
import { readFileSync } from 'node:fs';
import { streakConfig } from '../src/services/streak/streakConfig.js';
import { compareStreak, type OldRow, type StreakComparison } from '../src/services/streak/ledgerCompare.js';
import { daysAsV3, endsWithFailedDay } from '../src/services/streak/legacy.js';

/** A CSV as rows of cells (quoted cells, doubled quotes and line breaks inside quotes are read as CSV says). `NULL` stays the text `NULL`: the caller decides. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The rows of a CSV as objects by the header names. */
export function toObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const isNull = (v: string | undefined) => v === undefined || v === '' || v.toUpperCase() === 'NULL';

type Result = {
  id: string;
  status: string;
  userid: string;
  days: number;
  protectedDays: number;
  cmp?: StreakComparison;
  unreadable?: string;
};

export function analyse(streakRows: Record<string, string>[], ledgerRows: Record<string, string>[]) {
  const levels = streakConfig().levels;
  const byStreak = new Map<string, OldRow[]>();
  const known = new Set(streakRows.map(r => r.streak_id));
  let purchases = 0;
  let purchaseDays = 0;
  let otherTypes = 0;
  let orphans = 0;
  const balanceByUser = new Map<string, number>();
  for (const r of ledgerRows) {
    const days = Number(r.protection_days);
    balanceByUser.set(r.userid, (balanceByUser.get(r.userid) ?? 0) + days);
    if (r.transaction_type === 'iap') {
      purchases += 1;
      purchaseDays += days;
      continue;
    }
    if (r.transaction_type !== 'grant' && r.transaction_type !== 'consume') {
      otherTypes += 1;
      continue;
    }
    if (isNull(r.streak_id) || !known.has(r.streak_id)) {
      orphans += 1;
      continue;
    }
    const list = byStreak.get(r.streak_id) ?? [];
    list.push({ type: r.transaction_type, levelId: isNull(r.level_id) ? '' : r.level_id, dtgraph: Number(r.dtgraph), days });
    byStreak.set(r.streak_id, list);
  }

  let failedDays = 0;
  const results: Result[] = streakRows.map(s => {
    let logs: { level_id: string; logs: { s?: number; p?: true; n?: true }[] }[] = [];
    try {
      logs = JSON.parse(isNull(s.daily_logs) ? '[]' : s.daily_logs);
      if (!Array.isArray(logs)) throw new Error('daily_logs is not a list');
    } catch (e) {
      return { id: s.streak_id, status: s.status, userid: s.userid, days: 0, protectedDays: 0, unreadable: (e as Error).message };
    }
    const goal = Number(s.goal);
    // The old app keeps the day a streak failed on as its last entry (legacy.ts): it is read as v3 reads it, without that entry.
    const failedDay = endsWithFailedDay(s.status, goal, logs);
    logs = daysAsV3(s.status, goal, logs);
    if (failedDay) failedDays += 1;
    const all = logs.flatMap(l => l.logs ?? []);
    return {
      id: s.streak_id,
      status: s.status,
      userid: s.userid,
      days: all.length,
      protectedDays: all.filter(d => d.p).length,
      cmp: compareStreak(Number(s.start_date), logs, byStreak.get(s.streak_id) ?? [], levels),
    };
  });
  return { results, purchases, purchaseDays, otherTypes, orphans, balanceByUser, failedDays };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

export function report(streakRows: Record<string, string>[], ledgerRows: Record<string, string>[], details = false): string {
  const { results, purchases, purchaseDays, otherTypes, orphans, balanceByUser, failedDays } = analyse(streakRows, ledgerRows);
  const ok = results.filter((r): r is Result & { cmp: StreakComparison } => !!r.cmp);
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line('PROTECTION LEDGER DRY RUN');
  line(`streaks: ${results.length} (${ok.length} read, ${results.length - ok.length} with unreadable daily_logs)`);
  const byStatus = new Map<string, number>();
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  line(`  by status: ${[...byStatus].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  line(`  failed streaks whose last entry is the day it failed on (the old app's way, read without it): ${failedDays}`);
  line(`ledger rows: ${ledgerRows.length}: ${purchases} purchases (${purchaseDays} days), ${orphans} grant/consume rows of a streak not in the export, ${otherTypes} of another type`);
  line(`users with rows: ${balanceByUser.size}; balances: min ${Math.min(0, ...balanceByUser.values())}, max ${Math.max(0, ...balanceByUser.values())}; negative: ${[...balanceByUser.values()].filter(b => b < 0).length}`);
  line();
  const same = ok.filter(r => r.cmp.same);
  const onlyMissing = ok.filter(r => !r.cmp.same && r.cmp.extra.length === 0);
  const onlyExtra = ok.filter(r => !r.cmp.same && r.cmp.missing.length === 0);
  const both = ok.filter(r => r.cmp.missing.length > 0 && r.cmp.extra.length > 0);
  line('STREAKS, days against ledger');
  line(`  the same events:                         ${same.length} (${pct(same.length, ok.length)})`);
  line(`  days imply events the ledger lacks only: ${onlyMissing.length}   (NOT credited: the days are settled)`);
  line(`  ledger has rows no day implies only:     ${onlyExtra.length}   (left as they are; a rewrite would have REMOVED them)`);
  line(`  both:                                    ${both.length}`);
  line();
  const append = ok.reduce((t, r) => t + r.cmp.appendDelta, 0);
  const rewrite = ok.reduce((t, r) => t + r.cmp.rewriteDelta, 0);
  const lost = ok.reduce((t, r) => t + r.cmp.extra.reduce((x, e) => x + e.days, 0), 0);
  line('BALANCE, in protection days across all streaks');
  line(`  the ledger lacks, for days now settled: ${append >= 0 ? '+' : ''}${append} (not credited)`);
  line(`  a rewrite would have made:              ${rewrite >= 0 ? '+' : ''}${rewrite} (the same, less the ${lost} days of rows it would have removed)`);
  const spentRows = ok.reduce((t, r) => t + r.cmp.consumes.total, 0);
  const onP = ok.reduce((t, r) => t + r.cmp.consumes.onProtectedDay, 0);
  line();
  line('DAY LABELS (the day a consume row sits on, against the days marked protected)');
  line(`  consume rows of the streaks read: ${spentRows}; on a day the days mark protected: ${onP} (${pct(onP, spentRows)})`);
  line(`  a low share means the day labels (start_date plus the day's place) do not match the old rows: look before anything is built on them`);
  const spread = (xs: number[]) => {
    const c = new Map<number, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k >= 0 ? '+' : ''}${k}: ${v}`).join('  ');
  };
  line();
  line(`per-streak gap the server leaves (days: streaks): ${spread(ok.map(r => r.cmp.appendDelta)) || 'none'}`);
  line(`per-streak change if REWRITTEN (days: streaks):   ${spread(ok.map(r => r.cmp.rewriteDelta)) || 'none'}`);
  if (details) {
    line();
    line('DIFFERENT STREAKS (first 8 characters of the id)');
    for (const r of ok.filter(x => !x.cmp.same).sort((a, b) => Math.abs(b.cmp.rewriteDelta) - Math.abs(a.cmp.rewriteDelta))) {
      line(`  ${r.id.slice(0, 8)} ${r.status.padEnd(11)} days ${String(r.days).padStart(4)} (protected ${r.protectedDays})  not credited ${r.cmp.missing.length}, ledger has ${r.cmp.extra.length} the days do not imply, rewrite ${r.cmp.rewriteDelta >= 0 ? '+' : ''}${r.cmp.rewriteDelta}`);
    }
    for (const r of results.filter(x => x.unreadable)) line(`  ${r.id.slice(0, 8)} unreadable daily_logs: ${r.unreadable}`);
  }
  return out.join('\n');
}

const [, , streakFile, ledgerFile, ...flags] = process.argv;
if (streakFile && ledgerFile && process.argv[1]?.endsWith('ledger-dry-run.ts')) {
  console.log(report(toObjects(readFileSync(streakFile, 'utf8')), toObjects(readFileSync(ledgerFile, 'utf8')), flags.includes('--details')));
} else if (process.argv[1]?.endsWith('ledger-dry-run.ts')) {
  console.error('usage: npx tsx scripts/ledger-dry-run.ts streak_logs.csv protection_logs.csv [--details]');
  process.exit(1);
}
