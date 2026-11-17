/** An activity as the app sends it (docs/data/format.md section 1, api.md section 2), after it has been checked.
 *  `userid` is not here: the owner is always the token's user. */
export interface ActivityInput {
  activityid: string;
  downloadid: string;
  startdate: number;
  enddate: number;
  dtgraph?: number | null;
  lat: number;
  lon: number;
  temp?: number | null;
  realfeel?: number | null;
  humidity?: number | null;
  duration?: number | null;
  stepcount?: number | null;
  distance?: number | null;
  wind?: number | null;
  uvi?: number | null;
  iso?: string | null;
  weathericon?: string | null;
  weather?: string | null;
  city?: string | null;
  state?: string | null;
  aqi?: number | null;
  iswatch?: boolean | null;
  description?: string | null;
  /** The track: one entry per point, the same length in every array that is present. */
  activitylat?: number[] | null;
  activitylon?: number[] | null;
  activitytimenow?: number[] | null;
  activityelevation?: number[] | null;
  activitydistance?: number[] | null;
  activitydetail_v2?: Record<string, unknown> | null;
  activitybpm_v2?: Record<string, unknown> | null;
  device?: Record<string, unknown> | null;
  /** Stored as received; the media slice defines the items (format.md section 4). */
  media_v2?: unknown[] | null;
}

export type ActivityStatus = 'created' | 'exists' | 'deleted';

/** One answer per item sent, in the order sent (api.md section 2). */
export type ActivityResult =
  | { activityid: string; status: ActivityStatus; tosend: number }
  | { activityid: string | null; status: 'invalid'; error: string };

export interface BatchResponse {
  results: ActivityResult[];
}

/** What the upsert statement returns for each row it wrote. */
export interface WrittenRow {
  tosend: number;
  inserted: boolean;
}

/** An item that passed the checks, or why it did not. */
export type ParsedActivity =
  | { ok: true; row: ActivityInput }
  | { ok: false; activityid: string | null; error: string };
