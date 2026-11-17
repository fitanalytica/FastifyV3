// The route preview (docs/data/format.md section 6): a small version of an activity's route for a feed card. The PHONE makes it when it uploads an activity (the same
// Ramer-Douglas-Peucker it draws maps with); this is the same thing for what the phone never sent (the activities that were there before, see
// docs/data/backfill-route-preview.ts). The two must agree, so the numbers are the same: tolerance 6 m, at most 120 points.

/** The most points a preview has. */
export const PREVIEW_POINTS = 120;
/** How far a dropped point may be from the line, in metres, to start with. It grows until the preview fits PREVIEW_POINTS. */
export const PREVIEW_TOLERANCE_M = 6;

/** Metres in 1e-5 degrees of latitude. */
const M_PER_UNIT = 1.11320;

export interface RoutePreview {
  /** `[lat0, lon0, dlat1, dlon1, ...]` in 1e-5 degrees: the first point, then the step to each next point. */
  p: number[];
}

/**
 * Ramer-Douglas-Peucker, iterative so a long route cannot overflow the stack. Returns every point that sticks out more than `tolerance` metres from the
 * line between the points kept around it, with how far it stuck out (its significance), in the order they are found.
 */
function rdp(xs: number[], ys: number[], tolerance: number): { i: number; d: number }[] {
  const n = xs.length;
  const found: { i: number; d: number }[] = [];
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const dx = xs[b] - xs[a], dy = ys[b] - ys[a];
    const len2 = dx * dx + dy * dy;
    let far = -1, farD = tolerance;
    for (let i = a + 1; i < b; i++) {
      // distance from the segment a-b (a point beyond an end is measured to that end)
      let t = len2 ? ((xs[i] - xs[a]) * dx + (ys[i] - ys[a]) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(xs[i] - (xs[a] + t * dx), ys[i] - (ys[a] + t * dy));
      if (d > farD) { farD = d; far = i; }
    }
    if (far >= 0) { found.push({ i: far, d: farD }); stack.push([a, far], [far, b]); }
  }
  return found;
}

/**
 * The preview of a track given as absolute points in 1e-5 degrees, or null when there are fewer than two (an indoor activity). Points on top of each other are
 * thinned first (a phone standing still jitters), then RDP at 6 m; if more than 120 points are left, the 120 that stick out most are kept.
 */
export function routePreview(lat: number[], lon: number[]): RoutePreview | null {
  const n = Math.min(lat.length, lon.length);
  if (n < 2) return null;
  const cos = Math.cos((lat[0] / 1e5) * Math.PI / 180);
  const xs = Array.from({ length: n }, (_, i) => (lon[i] - lon[0]) * M_PER_UNIT * cos);
  const ys = Array.from({ length: n }, (_, i) => (lat[i] - lat[0]) * M_PER_UNIT);
  // thin points within 1.5 m of the last kept one (a quarter of the tolerance), keeping the last point
  const thinned: number[] = [0];
  for (let i = 1; i < n - 1; i++) {
    const last = thinned[thinned.length - 1];
    if (Math.hypot(xs[i] - xs[last], ys[i] - ys[last]) >= PREVIEW_TOLERANCE_M / 4) thinned.push(i);
  }
  thinned.push(n - 1);
  const tx = thinned.map((i) => xs[i]), ty = thinned.map((i) => ys[i]);
  // every point that sticks out more than the tolerance; if that is more than fit, the ones that stick out most (the two ends always stay)
  const found = rdp(tx, ty, PREVIEW_TOLERANCE_M).sort((p, q) => q.d - p.d).slice(0, PREVIEW_POINTS - 2).map((f) => f.i);
  const points = [0, ...found.sort((p, q) => p - q), tx.length - 1].map((k) => thinned[k]);
  const p = [lat[points[0]], lon[points[0]]];
  for (let i = 1; i < points.length; i++) p.push(lat[points[i]] - lat[points[i - 1]], lon[points[i]] - lon[points[i - 1]]);
  return { p };
}

/** The preview's points as absolute `[lat, lon]` in 1e-5 degrees (what the phone does to draw it). */
export function previewPoints(preview: RoutePreview): [number, number][] {
  const out: [number, number][] = [];
  let lat = 0, lon = 0;
  for (let i = 0; i < preview.p.length; i += 2) {
    lat = i === 0 ? preview.p[0] : lat + preview.p[i];
    lon = i === 0 ? preview.p[1] : lon + preview.p[i + 1];
    out.push([lat, lon]);
  }
  return out;
}

/** Is this what a phone may send as `route_preview`? An object with `p`: an even number of integers, 2 to 120 points. */
export function isRoutePreview(v: unknown): v is RoutePreview {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = (v as { p?: unknown }).p;
  return Array.isArray(p) && p.length >= 4 && p.length <= PREVIEW_POINTS * 2 && p.length % 2 === 0 && p.every((n) => Number.isInteger(n) && Math.abs(n as number) <= 2_000_000_000);
}
