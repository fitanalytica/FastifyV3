import type { FastifyInstance } from 'fastify';
import type { ActivityInput, ActivityResult, AuthInfo, WrittenRow } from '../../types/index.js';
import { collectDownloadIds, parseActivity } from './validate.js';

// docs/data/api.md section 2, server.md section 2, format.md section 1.
export const MAX_BATCH = 20;

const COLS = `activityid uuid, downloadid uuid, startdate int, enddate int, dtgraph int,
  lat double precision, lon double precision, temp smallint, realfeel smallint, humidity smallint,
  duration int, stepcount int, distance int, wind real, uvi real, iso text, weathericon text, weather text,
  city text, state text, aqi smallint, iswatch boolean, description text,
  activitydetail_v2 jsonb, activitybpm_v2 jsonb, activitylat jsonb, activitylon jsonb, activitytimenow jsonb,
  activityelevation jsonb, activitydistance jsonb, device jsonb, media_v2 jsonb, route_preview jsonb`;

// A JSON null arrives as jsonb 'null': store SQL NULL instead, so empty columns look the same as before.
const J = (c: string) => `NULLIF(${c}, 'null'::jsonb)::json`;

// One statement for the whole batch. The server sets userid (from the token) and tosend (from the device kind).
// On a repeat only tosend and the editable columns change; another user's row is never touched.
const SQL = `
INSERT INTO activities (activityid, userid, downloadid, startdate, enddate, dtgraph, lat, lon, geom,
  temp, realfeel, humidity, duration, stepcount, distance, wind, uvi, iso, weathericon, weather, city, state, aqi,
  iswatch, description, activitydetail_v2, activitybpm_v2, activitylat, activitylon, activitytimenow,
  activityelevation, activitydistance, device, media_v2, route_preview, tosend)
SELECT activityid, $2::uuid, downloadid, startdate, enddate, dtgraph, lat, lon, ST_SetSRID(ST_MakePoint(lon, lat), 4326),
  temp, realfeel, humidity, duration, stepcount, distance, wind, uvi, left(iso, 2), left(weathericon, 3),
  left(weather, 100), left(city, 50), left(state, 50), aqi,
  COALESCE(iswatch, false), description, ${J('activitydetail_v2')}, ${J('activitybpm_v2')}, ${J('activitylat')},
  ${J('activitylon')}, ${J('activitytimenow')}, ${J('activityelevation')}, ${J('activitydistance')}, ${J('device')},
  COALESCE(NULLIF(media_v2, 'null'::jsonb), '[]'::jsonb), NULLIF(route_preview, 'null'::jsonb), $3::smallint
FROM jsonb_to_recordset($1::jsonb) AS x(${COLS})
ON CONFLICT (activityid) DO UPDATE
   SET tosend      = LEAST(activities.tosend, EXCLUDED.tosend),
       media_v2    = CASE WHEN activities.tosend > 0 THEN EXCLUDED.media_v2    ELSE activities.media_v2    END,
       description = CASE WHEN activities.tosend > 0 THEN EXCLUDED.description ELSE activities.description END,
       -- the route preview is made from the track, which a resend never changes: it is only ever filled in, never replaced
       route_preview = CASE WHEN activities.tosend > 0 THEN COALESCE(activities.route_preview, EXCLUDED.route_preview) ELSE activities.route_preview END
   WHERE activities.userid = EXCLUDED.userid
RETURNING activityid, tosend, (xmax = 0) AS inserted`;

async function write(app: FastifyInstance, items: ActivityInput[], userid: string, tosend: number) {
  const r = await app.pg.writer.query(SQL, [JSON.stringify(items), userid, tosend]);
  return new Map<string, WrittenRow>(
    r.rows.map((x) => [x.activityid as string, { tosend: Number(x.tosend), inserted: x.inserted as boolean }]));
}

const DOWNLOADS = 'SELECT downloadid FROM downloads WHERE userid = $1 AND downloadid = ANY($2::uuid[])';

/** Which of these downloads rows belong to the user: one query for all of them. */
async function ownedDownloads(app: FastifyInstance, userid: string, ids: string[]): Promise<Set<string>> {
  const owned = new Set<string>();
  if (!ids.length) return owned;
  const r = await app.pg.reader.query(DOWNLOADS, [userid, ids]);
  for (const x of r.rows) owned.add(x.downloadid);
  // The reader can lag behind: ask the writer for any id it did not find.
  if (owned.size < ids.length) {
    const w = await app.pg.writer.query(DOWNLOADS, [userid, ids]);
    for (const x of w.rows) owned.add(x.downloadid);
  }
  return owned;
}

const isDataError = (e: unknown): boolean => /^2[23]/.test((e as { code?: string })?.code ?? '');

/** Writes a batch and answers one result per item, in the order received. */
export async function upsertBatch(app: FastifyInstance, auth: AuthInfo, activities: unknown[]): Promise<ActivityResult[]> {
  const tosend = auth.deviceType === 'watch' ? 2 : 1;
  const results: (ActivityResult | undefined)[] = new Array(activities.length);
  const owned = await ownedDownloads(app, auth.userid, collectDownloadIds(activities, auth.downloadid));

  const good: { i: number; row: ActivityInput }[] = [];
  const slot = new Map<string, number>(); // the same id twice in one batch: the later one wins
  activities.forEach((raw, i) => {
    const p = parseActivity(raw, owned, auth.downloadid);
    if (!p.ok) { results[i] = { activityid: p.activityid, status: 'invalid', error: p.error }; return; }
    const at = slot.get(p.row.activityid);
    if (at !== undefined) good[at] = { i, row: p.row };
    else { slot.set(p.row.activityid, good.length); good.push({ i, row: p.row }); }
  });

  const answer = (i: number, id: string, m: Map<string, WrittenRow>) => {
    const hit = m.get(id);
    results[i] = !hit ? { activityid: id, status: 'invalid', error: 'not_owner' }
      : hit.tosend === 0 ? { activityid: id, status: 'deleted', tosend: 0 }
      : { activityid: id, status: hit.inserted ? 'created' : 'exists', tosend: hit.tosend };
  };

  if (good.length) {
    try {
      const m = await write(app, good.map((g) => g.row), auth.userid, tosend);
      for (const g of good) answer(g.i, g.row.activityid, m);
    } catch (e) {
      // A data or integrity error (class 22 or 23) in one item fails the whole statement: find that item.
      if (!isDataError(e)) throw e;
      for (const g of good) {
        try { answer(g.i, g.row.activityid, await write(app, [g.row], auth.userid, tosend)); }
        catch (e2) {
          if (!isDataError(e2)) throw e2;
          results[g.i] = { activityid: g.row.activityid, status: 'invalid', error: 'rejected' };
        }
      }
    }
  }
  // An item overwritten by a later duplicate answers like it.
  activities.forEach((raw, i) => {
    if (results[i]) return;
    const id = String((raw as { activityid: string }).activityid).toLowerCase();
    const winner = results[good[slot.get(id)!].i]!;
    results[i] = 'status' in winner && winner.status !== 'invalid' ? { ...winner, activityid: id } : winner;
  });
  return results as ActivityResult[];
}
