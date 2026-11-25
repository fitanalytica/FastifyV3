import { describe, expect, test } from 'vitest';
import { analyse, parseCsv, report, toObjects } from '../../scripts/ledger-dry-run.js';
import { compareStreak } from '../../src/services/streak/ledgerCompare.js';
import { streakConfig } from '../../src/services/streak/streakConfig.js';

// The dry run over the old app's ledger (scripts/ledger-dry-run.ts): what appending would add, what a rewrite would have removed.
const L = streakConfig().levels;
const START = 1785283200;
const DAY = 86400;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const logs = (days: object[]) => q(JSON.stringify([{ level_id: L[0].level_id, logs: days }]));

const streakCsv = [
  'streak_id,userid,level_id,start_date,end_date,goal,duration,status,protection_used,daily_logs',
  // A: two kept days and a protected one: the old rows are exactly what the days imply.
  `aaaaaaaa-0000-4000-8000-000000000001,u1,${L[0].level_id},${START},NULL,8000,2,in_progress,1,${logs([{ s: 9000 }, { s: 9000 }, { s: 100, p: true }])}`,
  // B: the old app charged day 2 and the day was lifted later: the days have no `p` there.
  `bbbbbbbb-0000-4000-8000-000000000002,u2,${L[0].level_id},${START},NULL,8000,3,in_progress,0,${logs([{ s: 9000 }, { s: 9000 }, { s: 9000 }])}`,
  // C: seven kept days and no ledger rows at all.
  `cccccccc-0000-4000-8000-000000000003,u3,${L[1].level_id},${START},NULL,8000,7,in_progress,0,${logs(Array.from({ length: 7 }, () => ({ s: 9000 })))}`,
  // D: daily_logs that cannot be read.
  `dddddddd-0000-4000-8000-000000000004,u4,${L[0].level_id},${START},NULL,8000,0,failed,0,${q('not json')}`,
].join('\n');

const ledgerCsv = [
  'protection_id,streak_id,level_id,userid,dtgraph,protection_days,transaction_type,ddate,transaction_id',
  `p1,aaaaaaaa-0000-4000-8000-000000000001,${L[0].level_id},u1,${START + DAY},2,grant,1,NULL`,
  `p2,aaaaaaaa-0000-4000-8000-000000000001,${L[1].level_id},u1,${START + 2 * DAY},-1,consume,2,NULL`,
  `p3,bbbbbbbb-0000-4000-8000-000000000002,${L[0].level_id},u2,${START + DAY},2,grant,3,NULL`,
  `p4,bbbbbbbb-0000-4000-8000-000000000002,${L[1].level_id},u2,${START + 5 * DAY},-1,consume,4,NULL`,
  'p5,NULL,NULL,u3,NULL,25,iap,5,NULL',
  `p6,ffffffff-0000-4000-8000-00000000000f,${L[0].level_id},u9,${START},2,grant,6,NULL`,
].join('\n');

describe('reading the exports', () => {
  test('quoted cells, doubled quotes and line breaks inside quotes are read as CSV says', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",3\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
    expect(toObjects('a,b\r\n1,2\r\n')).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('comparing one streak', () => {
  test('the same events: nothing to add, nothing a rewrite would remove, and the consume sits on the protected day', () => {
    const cmp = compareStreak(START, [{ level_id: L[0].level_id, logs: [{ s: 1 }, { s: 1 }, { s: 1, p: true }] }], [
      { type: 'grant', levelId: L[0].level_id, dtgraph: START + DAY, days: 2 },
      { type: 'consume', levelId: L[0].level_id, dtgraph: START + 2 * DAY, days: -1 },
    ]);
    expect(cmp).toMatchObject({ same: true, appendDelta: 0, rewriteDelta: 0, consumes: { total: 1, onProtectedDay: 1 } });
  });

  test('an old charge for a day the days no longer mark protected: appending leaves it, a rewrite would have refunded it', () => {
    const cmp = compareStreak(START, [{ level_id: L[0].level_id, logs: [{ s: 1 }, { s: 1 }, { s: 1 }] }], [
      { type: 'grant', levelId: L[0].level_id, dtgraph: START + DAY, days: 2 },
      { type: 'consume', levelId: L[0].level_id, dtgraph: START + 5 * DAY, days: -1 },
    ]);
    expect(cmp).toMatchObject({ same: false, appendDelta: 0, rewriteDelta: 1, consumes: { total: 1, onProtectedDay: 0 } });
    expect(cmp.extra).toHaveLength(1);
    expect(cmp.missing).toEqual([]);
  });
});

describe('the report', () => {
  const result = analyse(toObjects(streakCsv), toObjects(ledgerCsv));

  test('the streaks are sorted into the same, only missing, only extra, and unreadable', () => {
    const byId = (id: string) => result.results.find(r => r.id.startsWith(id));
    expect(byId('aaaaaaaa')?.cmp?.same).toBe(true);
    expect(byId('bbbbbbbb')?.cmp).toMatchObject({ appendDelta: 0, rewriteDelta: 1 });
    expect(byId('cccccccc')?.cmp).toMatchObject({ appendDelta: 4, rewriteDelta: 4 });
    expect(byId('dddddddd')?.unreadable).toBeDefined();
    expect(result).toMatchObject({ purchases: 1, purchaseDays: 25, orphans: 1, otherTypes: 0 });
  });

  test('it says what appending would add against what a rewrite would have changed, and counts the day labels', () => {
    const text = report(toObjects(streakCsv), toObjects(ledgerCsv), true);
    expect(text).toContain('streaks: 4 (3 read, 1 with unreadable daily_logs)');
    expect(text).toContain('the same events:                         1 (33.3%)');
    expect(text).toContain('the ledger lacks, for days now settled: +4 (not credited)');
    expect(text).toContain('a rewrite would have made:              +5');
    expect(text).toContain('consume rows of the streaks read: 2; on a day the days mark protected: 1 (50.0%)');
    expect(text).toContain('bbbbbbbb');
    expect(text).toContain('unreadable daily_logs');
  });

  test('it prints counts and sums only: no user id and no full streak id', () => {
    const text = report(toObjects(streakCsv), toObjects(ledgerCsv), true);
    expect(text).not.toMatch(/\bu[1-9]\b/);
    expect(text).not.toContain('aaaaaaaa-0000');
  });
});
