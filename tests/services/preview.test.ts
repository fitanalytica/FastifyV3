import { test, expect } from 'vitest';
import { PREVIEW_POINTS, isRoutePreview, previewPoints, routePreview } from '../../src/services/activities/preview.js';

// 1e-5 degrees. At 12.97 N: 1 unit of latitude is 1.113 m, 1 unit of longitude about 1.085 m.
const line = (n: number, dlat = 0, dlon = 20) => ({ lat: Array.from({ length: n }, (_, i) => 1297160 + i * dlat), lon: Array.from({ length: n }, (_, i) => 7759457 + i * dlon) });

test('a straight line is two points: its ends', () => {
  const { lat, lon } = line(500);
  const p = routePreview(lat, lon)!;
  expect(previewPoints(p)).toEqual([[1297160, 7759457], [1297160, 7759457 + 499 * 20]]);
});

test('the first point is absolute and the rest are steps, in 1e-5 degrees, that add back up to the points', () => {
  const lat = [1000000, 1000100, 1000100, 1000300];
  const lon = [2000000, 2000000, 2000500, 2000500];
  const p = routePreview(lat, lon)!;
  expect(p.p.slice(0, 2)).toEqual([1000000, 2000000]);
  expect(previewPoints(p)).toEqual([[1000000, 2000000], [1000100, 2000000], [1000100, 2000500], [1000300, 2000500]]); // a Z: every corner is kept
  expect(p.p.every(Number.isInteger)).toBe(true);
});

test('a corner further than the tolerance is kept; a wobble within it is dropped', () => {
  // 300 units (about 325 m) east, then 300 north: the corner stays. A 2 m wobble along the first leg does not.
  const lat: number[] = [], lon: number[] = [];
  for (let i = 0; i <= 30; i++) { lon.push(7759457 + i * 10); lat.push(1297160 + (i % 2)); }
  for (let i = 1; i <= 30; i++) { lon.push(7759457 + 300); lat.push(1297160 + i * 10); }
  const pts = previewPoints(routePreview(lat, lon)!);
  expect(pts.length).toBe(3);
  expect(pts[1]).toEqual([1297160 + 0, 7759457 + 300]);
});

test('standing still (many points on top of each other) is thinned, not counted', () => {
  const lat = Array.from({ length: 5000 }, () => 1297160), lon = Array.from({ length: 5000 }, () => 7759457);
  lat.push(1297160 + 500); lon.push(7759457 + 500);
  const pts = previewPoints(routePreview(lat, lon)!);
  expect(pts.length).toBe(2);
});

test('a winding route is never more than 120 points: the tolerance grows until it fits', () => {
  const lat = Array.from({ length: 4000 }, (_, i) => 1297160 + Math.round(Math.sin(i / 7) * 3000)), lon = Array.from({ length: 4000 }, (_, i) => 7759457 + i * 4);
  const p = routePreview(lat, lon)!;
  expect(previewPoints(p).length).toBeLessThanOrEqual(PREVIEW_POINTS);
  expect(previewPoints(p).length).toBeGreaterThan(20);
  expect(isRoutePreview(p)).toBe(true);
});

test('no route: fewer than two points gives none (an indoor activity)', () => {
  expect(routePreview([], [])).toBeNull();
  expect(routePreview([1], [1])).toBeNull();
});

test('the preview is far smaller than the track it came from', () => {
  const lat = Array.from({ length: 3000 }, (_, i) => 1297160 + Math.round(Math.sin(i / 90) * 800)), lon = Array.from({ length: 3000 }, (_, i) => 7759457 + i * 3);
  expect(JSON.stringify(routePreview(lat, lon)).length).toBeLessThan(JSON.stringify([lat, lon]).length / 20);
});

test('what a phone may send: an object with an even number of integers, 2 to 120 points', () => {
  expect(isRoutePreview({ p: [1, 2, 3, 4] })).toBe(true);
  expect(isRoutePreview({ p: Array.from({ length: 240 }, () => 1) })).toBe(true);
  for (const bad of [null, [], 'x', {}, { p: [] }, { p: [1, 2] }, { p: [1, 2, 3] }, { p: Array.from({ length: 242 }, () => 1) }, { p: [1, 2, 3, 1.5] }, { p: [1, 2, 3, '4'] }, { p: [1, 2, 3, 3e10] }]) {
    expect(isRoutePreview(bad), JSON.stringify(bad)).toBe(false);
  }
});
