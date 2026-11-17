import type { ActivityInput, ParsedActivity } from '../../types/index.js';

// docs/data/api.md section 2. Only what would break the write or the data is checked here:
// the server never reads inside the JSON columns.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4 = 2147483647;

type Raw = Record<string, unknown>;

const isInt = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const nul = (v: unknown): boolean => v === undefined || v === null;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

const SMALLINTS = ['temp', 'realfeel', 'humidity', 'aqi'] as const;
const INTS = ['duration', 'stepcount', 'distance'] as const;
const TRACK = ['activitylat', 'activitylon', 'activitytimenow', 'activityelevation', 'activitydistance'] as const;
const OBJECTS = ['activitydetail_v2', 'activitybpm_v2', 'device'] as const;
const TEXTS = ['iso', 'weathericon', 'weather', 'city', 'state', 'description'] as const;

/** The reason an item is refused, or null. `owned` is the set of the user's downloadids. */
export function invalidReason(a: Raw, owned: ReadonlySet<string>): string | null {
  if (!isInt(a.startdate, 0, INT4) || !isInt(a.enddate, 0, INT4) || (a.enddate as number) < (a.startdate as number)) return 'bad_dates';
  if (!isNum(a.lat, -90, 90) || !isNum(a.lon, -180, 180)) return 'bad_location';
  for (const k of INTS) if (!nul(a[k]) && !isInt(a[k], 0, INT4)) return `bad_${k}`;
  for (const k of SMALLINTS) if (!nul(a[k]) && !isInt(a[k], -32768, 32767)) return `bad_${k}`;
  for (const k of ['wind', 'uvi']) if (!nul(a[k]) && !isNum(a[k], -1e6, 1e6)) return `bad_${k}`;
  for (const k of TEXTS) if (!nul(a[k]) && typeof a[k] !== 'string') return `bad_${k}`;
  if (typeof a.description === 'string' && a.description.length > 200) return 'description_too_long';
  if (!nul(a.iswatch) && typeof a.iswatch !== 'boolean') return 'bad_iswatch';
  let len: number | undefined;
  for (const k of TRACK) {
    const v = a[k];
    if (nul(v)) continue;
    if (!Array.isArray(v)) return 'bad_track';
    if (len !== undefined && v.length !== len) return 'bad_track'; // one entry per point, in every array
    len = v.length;
  }
  for (const k of OBJECTS) if (!nul(a[k]) && !isObject(a[k])) return `bad_${k}`;
  // activitydetail_v2 is what marks a row as NEW-format (its start point is the exact one in geom). A row that carries a track
  // without it would read as an old row, and its compact arrays would be taken from the wrong start. A resend without a track may leave both out.
  if (len !== undefined && nul(a.activitydetail_v2)) return 'missing_activitydetail_v2';
  if (!nul(a.media_v2) && !Array.isArray(a.media_v2)) return 'bad_media';
  if (typeof a.downloadid !== 'string' || !owned.has(a.downloadid)) return 'bad_downloadid';
  return null;
}

/** The downloadids a batch names (an item without one means the token's own device), so one query can check them all. */
export function collectDownloadIds(items: readonly unknown[], fallback: string): string[] {
  const ids = new Set<string>();
  for (const it of items) {
    const d = isObject(it) && it.downloadid !== undefined && it.downloadid !== null ? it.downloadid : fallback;
    if (typeof d === 'string' && UUID.test(d)) ids.add(d);
  }
  return [...ids];
}

/** Checks one item of a batch and returns it ready to write. `userid` in the body is dropped: the owner is the token's user. */
export function parseActivity(raw: unknown, owned: ReadonlySet<string>, fallbackDownloadid: string): ParsedActivity {
  if (!isObject(raw)) return { ok: false, activityid: null, error: 'not_an_object' };
  if (typeof raw.activityid !== 'string' || !UUID.test(raw.activityid)) return { ok: false, activityid: null, error: 'bad_activityid' };
  const activityid = raw.activityid.toLowerCase();
  const { userid: _ignored, ...rest } = raw;
  const row: Raw = { ...rest, activityid, downloadid: raw.downloadid ?? fallbackDownloadid };
  const why = invalidReason(row, owned);
  return why ? { ok: false, activityid, error: why } : { ok: true, row: row as unknown as ActivityInput };
}
