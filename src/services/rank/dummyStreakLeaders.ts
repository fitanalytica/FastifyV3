import { OF } from './dummyRank.js';

/**
 * The streak leaderboard as the sync call answers it (`down.streakLeaders`, docs/data/sync.md section 4d): **five people in rank order, you and the people next to you**, two above and two below (at the top: you and four
 * below; at the bottom: four above), each with a name, a country and the days of their current streak. `rank` is the user's own place among `of`.
 *
 * **Dummy for now**: there is no streaks service, so the user's place comes from the days the phone sent, among a short made-up ladder (a tie is the other person's). The shape is the real one: when the streaks exist only
 * this file changes (and the phone stops sending `days`).
 */
export type StreakLeaderPerson = { rank: number; name: string; country: string; days: number; you?: true };
export type StreakLeadersDown = { rank: number; of: number; people: StreakLeaderPerson[] };

export const WINDOW = 5;

const LADDER = [
  { name: 'Encarnación Guadalupe de los Ángeles Fernández-Villalobos', country: 'Spain', days: 120 },
  { name: 'Sakthivel Vel', country: 'India', days: 96 },
  { name: 'Aiko Tanaka-Yamamoto Kobayashi', country: 'Japan', days: 77 },
  { name: 'Maximilian von Hohenzollern-Sigmaringen III', country: 'Germany', days: 61 },
  { name: 'Nia Okafor', country: 'Nigeria', days: 55 },
  { name: 'Lucas Silva', country: 'Portugal', days: 49 },
  { name: 'Elena Rossi di Montelera e Castelbarco', country: 'Italy', days: 46 },
  { name: 'Balraj Dhillon', country: 'United Kingdom', days: 41 },
  { name: 'Mei Lin', country: 'Singapore', days: 33 },
  { name: 'Tom Becker', country: 'United States', days: 27 },
  { name: 'Priya Nair', country: 'India', days: 20 },
  { name: 'Sam Carter-Whitmore the Younger', country: 'United Kingdom', days: 12 },
  { name: 'Ana Costa', country: 'Brazil', days: 8 },
  { name: 'Jonas Berg', country: 'Sweden', days: 3 },
];

export function dummyStreakLeaders(days: number, country = ''): StreakLeadersDown {
  // One more than the people with at least as many days (a tie is theirs).
  const rank = 1 + LADDER.filter(p => p.days >= days).length;
  const all = [...LADDER.slice(0, rank - 1).map(p => ({ ...p, you: undefined as true | undefined })), { name: 'You', country, days, you: true as const }, ...LADDER.slice(rank - 1).map(p => ({ ...p, you: undefined as true | undefined }))];
  const from = Math.min(Math.max(rank - 3, 0), all.length - WINDOW);
  const people = all.slice(from, from + WINDOW).map((p, i) => ({ rank: from + i + 1, name: p.name, country: p.country, days: p.days, ...(p.you ? { you: true as const } : {}) }));
  return { rank, of: OF, people };
}
