import { describe, expect, test } from 'vitest';
import { dummyStreakLeaders } from '../../src/services/rank/dummyStreakLeaders.js';

// The streak leaderboard window (docs/data/sync.md section 4d).
describe('dummy streak leaders', () => {
  const you = (d: ReturnType<typeof dummyStreakLeaders>) => d.people.findIndex(p => p.you);

  test('five people in rank order, you in the middle: two above, two below', () => {
    const d = dummyStreakLeaders(44, 'India');
    expect(d.people).toHaveLength(5);
    expect(you(d)).toBe(2);
    expect(d.people[2]).toMatchObject({ you: true, days: 44, country: 'India', rank: d.rank });
    expect(d.people.map(p => p.rank)).toEqual([d.rank - 2, d.rank - 1, d.rank, d.rank + 1, d.rank + 2]);
    const days = d.people.map(p => p.days);
    expect([...days].sort((a, b) => b - a)).toEqual(days);
  });

  test('at the top the window is you and four below; at the bottom four above and you', () => {
    const top = dummyStreakLeaders(500);
    expect(top.rank).toBe(1);
    expect(top.people.map(p => p.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(you(top)).toBe(0);
    const bottom = dummyStreakLeaders(0);
    expect(bottom.people).toHaveLength(5);
    expect(you(bottom)).toBe(4);
    expect(bottom.people[4].rank).toBe(bottom.rank);
  });

  test('a tie is the other person’s: level with someone, you are just below them', () => {
    expect(dummyStreakLeaders(49).rank).toBe(7);
    expect(dummyStreakLeaders(50).rank).toBe(6);
  });
});
