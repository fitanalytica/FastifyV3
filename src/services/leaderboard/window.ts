/**
 * The five places of a leaderboard window: the user and the people next to them, two above and two below; at the top the user and four below, at the bottom four above (docs/data/sync.md section 4b). `above` and `below` are
 * the nearest first, as many as the board has (at most four each). Returns what to show above (nearest last, so it reads in rank order) and below.
 */
export function pickWindow<T>(above: T[], below: T[]): { above: T[]; below: T[] } {
  const a = Math.min(above.length, Math.max(2, 4 - below.length));
  const b = Math.min(below.length, 4 - a);
  return { above: above.slice(0, a).reverse(), below: below.slice(0, b) };
}
