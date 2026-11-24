import { describe, expect, test } from 'vitest';
import { CHALLENGERS, dummyChallengers } from '../../src/services/rank/dummyChallengers.js';

// The step challengers on Home (docs/data/sync.md section 4c).
describe('dummy challengers', () => {
  test('the first has 300, the seventh 150, and the leaders are in order', () => {
    const d = dummyChallengers(5);
    expect(d.top.map(p => p.steps)).toEqual([300, 275, 250, 225, 200, 175, 150, 125]);
    const totals = d.top.map(p => p.steps);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(d.top.map(p => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('a user with few steps is below the eight: the eight are the leaders, none is the user, and their rank is 9', () => {
    const d = dummyChallengers(5);
    expect(d.rank).toBe(9);
    expect(d.top.some(p => p.you)).toBe(false);
    expect(d.count).toBe(d.of);
  });

  test('passing the leaders one by one moves the user up, and the user is then one of the eight', () => {
    expect(dummyChallengers(125).rank).toBe(9); // a tie is the leader's
    expect(dummyChallengers(126).rank).toBe(8);
    const d = dummyChallengers(210);
    expect(d.rank).toBe(5);
    expect(d.top.find(p => p.you)).toMatchObject({ rank: 5, steps: 210 });
    expect(d.top.map(p => p.steps)).toEqual([300, 275, 250, 225, 210, 200, 175, 150]);
    expect(dummyChallengers(400).rank).toBe(1);
    expect(dummyChallengers(400).top[0]).toMatchObject({ you: true, rank: 1, steps: 400 });
  });

  test('the user\'s row carries the user\'s country, and the answer carries it too', () => {
    const d = dummyChallengers(210, 'India', 'IN');
    expect(d.country).toBe('India');
    expect(d.iso).toBe('IN');
    expect(d.top.find(p => p.you)?.country).toBe('India');
    expect(dummyChallengers(210).country).toBe('');
  });

  test('only a name and a country for each: no city', () => {
    for (const p of dummyChallengers(5).top) {
      expect(Object.keys(p).sort()).toEqual(['country', 'name', 'rank', 'steps']);
      expect(p.country).not.toContain(',');
    }
    expect(new Set(dummyChallengers(5).top.map(p => p.name)).size).toBe(8);
  });

  test('some names are long, to see them wrap', () => {
    expect(Math.max(...dummyChallengers(5).top.map(p => p.name.length))).toBeGreaterThan(35);
  });

  test('before any steps today only a few are on the board, and none is listed', () => {
    const d = dummyChallengers(0);
    expect(d.top).toEqual([]);
    expect(d.count).toBeLessThan(CHALLENGERS);
  });
});
