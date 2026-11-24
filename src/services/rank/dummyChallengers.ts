import { OF } from './dummyRank.js';

/**
 * The step challengers on Home (docs/data/sync.md section 4c): the first eight of today in rank order, **each with a name and a country only** (no city), the user
 * among them when they rank 8 or better (`you`), and `count`, how many have steps today. `rank` is the user's own rank today: when it is below eight the phone
 * shows the first seven and the user as the eighth, with that rank.
 *
 * **Dummy for now**: there is no leaderboard. The others are made up from a short list (with some very long names) with **totals from 300 (first) down to 150 (seventh)**, so a user who is walking is among them
 * and passes them one by one, and the user's rank is where their total falls among them (it can be 1 to 9). No steps today means `count` 3 and no list. When the leaderboard exists only this file changes.
 */
/** `userid` and `pic` (the file name of their profile picture) are there for someone who has one; the phone then shows it in the avatar. The dummy people have none. */
export type ChallengerPerson = { rank: number; name: string; country: string; steps: number; you?: true; userid?: string; pic?: string };
/** `country` (the name) and `iso` (its two-letter code) are the user's own, from their profile, or '' when they have none: the phone uses them for the user's own country when location is not allowed. */
export type ChallengersDown = { rank: number; of: number; count: number; country: string; iso: string; top: ChallengerPerson[] };

export const CHALLENGERS = 8;
/** Fewer than this many with steps today and the phone keeps showing the last full list. */
const EARLY_COUNT = 3;

// Some names are long on purpose, to see them wrap on the card.
const PEOPLE = [
  { name: 'Alexandra Konstantinopoulos-Fitzgerald', country: 'United States' },
  { name: 'Nia Okafor', country: 'Nigeria' },
  { name: 'Maximilian von Hohenzollern-Sigmaringen III', country: 'Germany' },
  { name: 'Lucas Silva', country: 'Portugal' },
  { name: 'Priyadarshini Venkatasubramanian Iyer', country: 'India' },
  { name: 'Elena Rossi', country: 'Italy' },
  { name: 'Sam Carter-Whitmore the Younger', country: 'United Kingdom' },
  { name: 'Mei Lin', country: 'Singapore' },
];
/** The leaders' totals today: the first has 300, the seventh 150, 25 apart, so a user who is walking passes them one by one (and the order changes with a few steps). */
const LEADERS = [300, 275, 250, 225, 200, 175, 150, 125];

export function dummyChallengers(daySteps: number, country = '', iso = ''): ChallengersDown {
  if (daySteps <= 0) {
    return { rank: CHALLENGERS + 1, of: OF, count: EARLY_COUNT, country, iso, top: [] };
  }
  // The user's rank among them: one more than the leaders with more steps (a tie is the leader's).
  const rank = 1 + LEADERS.filter(total => total >= daySteps).length;
  const others = LEADERS.map((steps, i) => ({ ...PEOPLE[(i + 3) % PEOPLE.length], steps }));
  const all: ChallengerPerson[] = [...others.slice(0, rank - 1).map(p => ({ ...p, rank: 0 })), { rank: 0, name: 'You', country, steps: daySteps, you: true as const }, ...others.slice(rank - 1).map(p => ({ ...p, rank: 0 }))];
  const top = all.slice(0, CHALLENGERS).map((p, i) => ({ ...p, rank: i + 1 }));
  return { rank, of: OF, count: OF, country, iso, top };
}
