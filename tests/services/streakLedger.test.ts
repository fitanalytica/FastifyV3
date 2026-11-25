import { describe, expect, test } from 'vitest';
import { ledgerRows, missingRows, rowKey, settledDays } from '../../src/services/streak/ledger.js';
import { streakConfig } from '../../src/services/streak/streakConfig.js';

// The protection days ledger, derived from a streak's days (docs/data/phone.md, "The streak").
const L = streakConfig().levels;
const START = 1795478400;
const DAY = 86400;
const kept = (n: number) => Array.from({ length: n }, () => ({ s: 9000 }));

describe('ledger rows from a streak’s days', () => {
  test('a level’s reward is granted on the day its duration is reached: Beginner (2 days) pays 2, Contender (7) pays 2', () => {
    const rows = ledgerRows(START, [{ level_id: L[0].level_id, logs: kept(2) }, { level_id: L[1].level_id, logs: kept(5) }]);
    expect(rows).toEqual([
      { type: 'grant', levelId: L[0].level_id, dtgraph: START + 1 * DAY, days: 2 },
      { type: 'grant', levelId: L[1].level_id, dtgraph: START + 6 * DAY, days: 2 },
    ]);
  });

  test('a protected day is a consume of one, on the day it covered and in the level it sat in; it does not count toward a level', () => {
    const rows = ledgerRows(START, [{ level_id: L[0].level_id, logs: [{ s: 9000 }, { s: 100, p: true }, { s: 9000 }] }]);
    expect(rows).toEqual([
      { type: 'consume', levelId: L[0].level_id, dtgraph: START + 1 * DAY, days: -1 },
      { type: 'grant', levelId: L[0].level_id, dtgraph: START + 2 * DAY, days: 2 },
    ]);
  });

  test('a day with no data counts for nothing: no grant moves, nothing is spent', () => {
    const rows = ledgerRows(START, [{ level_id: L[0].level_id, logs: [{ s: 9000 }, { s: 0, n: true }, { s: 9000 }] }]);
    expect(rows).toEqual([{ type: 'grant', levelId: L[0].level_id, dtgraph: START + 2 * DAY, days: 2 }]);
  });

  test('the last level pays nothing, and the rewards add up to the old app’s: 2 + 2 + 4 + 8 + 15 + 25 + 40 over 500 days', () => {
    const rows = ledgerRows(START, [{ level_id: L[0].level_id, logs: kept(1000) }]);
    expect(rows.map(r => r.days)).toEqual([2, 2, 4, 8, 15, 25, 40]);
    expect(rows.every(r => r.type === 'grant')).toBe(true);
  });

  test('nothing for a streak with no days', () => {
    expect(ledgerRows(START, [])).toEqual([]);
  });
});

describe('days the server already holds are settled', () => {
  test('how many days a stored daily_logs holds, as text or as parsed, and 0 for nothing readable', () => {
    const stored = [{ level_id: 'a', logs: [{ s: 1 }, { s: 1 }] }, { level_id: 'b', logs: [{ s: 1 }, { s: 1, p: true }, { s: 0, n: true }] }];
    expect(settledDays(stored)).toBe(5);
    expect(settledDays(JSON.stringify(stored))).toBe(5);
    expect(settledDays(null)).toBe(0);
    expect(settledDays('not json')).toBe(0);
    expect(settledDays([])).toBe(0);
    expect(settledDays({ logs: [1] })).toBe(0);
  });
});

describe('appending: only what the ledger does not have', () => {
  const derived = ledgerRows(START, [{ level_id: L[0].level_id, logs: [{ s: 9000 }, { s: 9000 }, { s: 100, p: true }] }]);

  test('an event that is already there is not added again; a new one is', () => {
    expect(missingRows(derived, [])).toEqual(derived);
    expect(missingRows(derived, [{ type: 'grant', levelId: L[0].level_id, dtgraph: START + DAY }])).toEqual([derived[1]]);
    expect(missingRows(derived, derived.map(r => ({ type: r.type, levelId: r.levelId, dtgraph: r.dtgraph })))).toEqual([]);
  });

  test('the old app’s rows count as the same event: a consume is a day, whatever level the old app put it in; a grant is a level on a day (ids in any case)', () => {
    const old = [
      { type: 'grant', levelId: L[0].level_id.toUpperCase(), dtgraph: START + DAY },
      { type: 'consume', levelId: L[3].level_id, dtgraph: START + 2 * DAY },
    ];
    expect(missingRows(derived, old)).toEqual([]);
    expect(rowKey('consume', 'x', 5)).toBe(rowKey('consume', 'y', 5));
    expect(rowKey('grant', 'x', 5)).not.toBe(rowKey('grant', 'y', 5));
    expect(rowKey('grant', 'x', 5)).not.toBe(rowKey('grant', 'x', 6));
  });

  test('rows the old app wrote that the days do not imply are not our business: nothing is derived from them, and they are never asked to go', () => {
    // An old consume for a day that was later lifted (it has no `p`): the days imply nothing for it, and nothing says to remove it.
    const oldOnly = [{ type: 'consume', levelId: L[0].level_id, dtgraph: START }];
    expect(missingRows(derived, oldOnly)).toEqual(derived);
  });
});
