import type { RankUp } from '../../types/index.js';

/**
 * The step leaderboards as the sync call answers them (`down.rank`, docs/data/sync.md section 4b): for each period, **five people in rank order: you and the people next to you**, two above and two below (at the top: you
 * and four below; at the bottom: four above), each with the total they had at the last update (up to yesterday, plus today's so far where the server has it). The phone adds the user's live steps and moves the user **only
 * within those five places**; the next sync (every six hours) brings the new rank. **Private users are left out of other people's ranking** (not counted in their rank, never shown beside them); a private user still gets their own rank, among the public ones. No one beside you is private.
 *
 * **Dummy for now**: there is no leaderboard, so the user's rank comes from the totals the phone sent (a fixed curve: more steps, a better rank) and the other four are made up from a short list. The shape is the real one: when
 * the leaderboard exists only this file changes (and the phone stops sending `steps`).
 */
export type RankPerson = { rank: number; name: string; place: string; steps: number; you?: true };
export type RankBlock = { rank: number; of: number; change: number; people: RankPerson[] };
export type RankDown = Record<'Day' | 'Week' | 'Month' | 'Year' | 'All time', RankBlock>;

type Period = keyof RankDown;
const PERIODS: Period[] = ['Day', 'Week', 'Month', 'Year', 'All time'];
/** A user at this many steps in the period is first. */
export const TOP: Record<Period, number> = { Day: 16_000, Week: 95_000, Month: 400_000, Year: 4_500_000, 'All time': 12_000_000 };
export const OF = 250_000;
const NAMES = [
  { name: 'Tom Becker', place: 'Austin, United States' },
  { name: 'Nia Okafor', place: 'Lagos, Nigeria' },
  { name: 'Aiko Tanaka', place: 'Osaka, Japan' },
  { name: 'Lucas Silva', place: 'Lisbon, Portugal' },
  { name: 'Priya Nair', place: 'Kochi, India' },
  { name: 'Elena Rossi', place: 'Milan, Italy' },
];

/** The five places of a window: the user's rank in the middle, moved to keep five (from 1 to OF). */
const windowStart = (rank: number) => Math.min(Math.max(rank - 2, 1), OF - 4);

export function block(period: Period, steps: number): RankBlock {
  const share = Math.min(steps / TOP[period], 1);
  const rank = Math.max(1, Math.round(OF * (1 - share) ** 2) + 1);
  const start = windowStart(rank);
  const people: RankPerson[] = [];
  for (let i = 0; i < 5; i++) {
    const r = start + i;
    if (r === rank) {
      people.push({ rank: r, name: 'You', place: '', steps, you: true });
      continue;
    }
    // Others are a few percent above or below, in order: the nearer the rank, the nearer the total.
    const gap = Math.max(Math.round(steps * 0.035 * Math.abs(r - rank)), 25);
    const who = NAMES[(steps + r) % NAMES.length];
    people.push({ rank: r, ...who, steps: r < rank ? steps + gap : Math.max(steps - gap, 0) });
  }
  return { rank, of: OF, change: (steps % 41) - 10, people };
}

export function dummyRank(up: RankUp): RankDown {
  const steps = up.steps ?? { Day: 0, Week: 0, Month: 0, Year: 0, 'All time': 0 };
  return Object.fromEntries(PERIODS.map(p => [p, block(p, steps[p])])) as RankDown;
}
