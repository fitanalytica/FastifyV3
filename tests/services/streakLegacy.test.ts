import { describe, expect, test } from 'vitest';
import { daysAsV3, endsWithFailedDay } from '../../src/services/streak/legacy.js';

// The old app keeps the day a streak failed on as its last entry; v3 does not (docs/data/sync.md section 5).
const logs = (...days: object[]) => [{ level_id: 'L0', logs: days }];

describe('the old app’s failed streaks', () => {
  test('a failed streak ending in a plain entry below 80% of the goal ends with the day it failed on', () => {
    expect(endsWithFailedDay('failed', 10000, logs({ s: 9000 }, { s: 9000 }, { s: 92 }))).toBe(true);
    expect(endsWithFailedDay('failed', 10000, logs({ s: 7999 }))).toBe(true);
    expect(endsWithFailedDay('failed', 10000, logs({ s: 8000 }))).toBe(false);
  });

  test('a protected day or a day with no data at the end is not the failed day, and neither is anything of a streak that is not failed', () => {
    expect(endsWithFailedDay('failed', 10000, logs({ s: 9000 }, { s: 100, p: true }))).toBe(false);
    expect(endsWithFailedDay('failed', 10000, logs({ s: 9000 }, { s: 0, n: true }))).toBe(false);
    expect(endsWithFailedDay('in_progress', 10000, logs({ s: 100 }))).toBe(false);
    expect(endsWithFailedDay('failed', 10000, [])).toBe(false);
  });

  test('read as v3 reads it: the last entry comes off, an emptied level goes, and the rest is untouched', () => {
    const old = [{ level_id: 'L0', logs: [{ s: 9000 }, { s: 9000 }] }, { level_id: 'L1', logs: [{ s: 50 }] }];
    expect(daysAsV3('failed', 10000, old)).toEqual([{ level_id: 'L0', logs: [{ s: 9000 }, { s: 9000 }] }]);
    expect(old[1].logs).toHaveLength(1);
    const kept = logs({ s: 9000 }, { s: 9000 });
    expect(daysAsV3('failed', 10000, kept)).toBe(kept);
    expect(daysAsV3('failed', 10000, logs({ s: 40 }))).toEqual([]);
  });
});
