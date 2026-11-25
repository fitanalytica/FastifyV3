import { describe, expect, test } from 'vitest';
import { streakConfig } from '../../src/services/streak/streakConfig.js';

// The streak's levels and notification texts (docs/data/sync.md section 4f).
describe('streak config', () => {
  const c = streakConfig();

  test('the levels are the journey: eight, in order, with the durations and rewards of the design', () => {
    expect(c.levels.map(l => [l.title, l.duration, l.reward])).toEqual([
      ['Beginner', 2, 2], ['Contender', 7, 2], ['Achiever', 21, 4], ['Champion', 60, 8], ['Warrior', 180, 15], ['Legend', 365, 25], ['Titan', 500, 40], ['Immortal', 1000, null],
    ]);
    expect(c.levels.every(l => /^[0-9a-f-]{36}$/.test(l.level_id))).toBe(true);
    const days = c.levels.map(l => l.duration);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });

  test('three pools of notification texts, each with a title and a body', () => {
    expect(Object.keys(c.messages)).toEqual(['daily_target', 'streak_at_risk', 'protection_used']);
    for (const pool of Object.values(c.messages)) {
      expect(pool.length).toBe(20);
      expect(pool.every(m => m.title.length > 0 && m.body.length > 0)).toBe(true);
    }
  });

  test('the version is a short hash that is the same each time', () => {
    expect(c.version).toMatch(/^[0-9a-f]{12}$/);
    expect(streakConfig().version).toBe(c.version);
  });
});
