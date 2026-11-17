// Fills `route_preview` for the activities that have a track but no preview: everything uploaded before the phone started sending one.
// The phone computes the preview for new activities; this uses the SAME rule (services/activities/preview.ts), in batches, safe to run again and to stop.
//   npm run backfill:preview                     (the database in PG_WRITER_URL, .env.local)
import pg from 'pg';
import { routePreview } from '../src/services/activities/preview.js';

const url = process.env.PG_WRITER_URL;
if (!url) throw new Error('PG_WRITER_URL is not set');
const BATCH = 200;
const client = new pg.Client({ connectionString: url, ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false });
await client.connect();

// The start point as the restore reads it: the exact one from `geom` for a new-format row, the `lat`/`lon` columns for an old one (format.md section 2).
const NEXT = `
  SELECT activityid,
         CASE WHEN activitydetail_v2 IS NOT NULL THEN ST_Y(geom) ELSE lat::text::float8 END AS lat0,
         CASE WHEN activitydetail_v2 IS NOT NULL THEN ST_X(geom) ELSE lon::text::float8 END AS lon0,
         activitylat, activitylon
    FROM activities
   WHERE route_preview IS NULL AND activitylat IS NOT NULL AND activitylon IS NOT NULL AND tosend > 0 AND activityid > $1
   ORDER BY activityid LIMIT ${BATCH}`;

const absolute = (increments: number[], start: number) => {
  let acc = start;
  return increments.map((d) => (acc += d));
};

let after = '00000000-0000-0000-0000-000000000000', done = 0, skipped = 0;
for (;;) {
  const { rows } = await client.query(NEXT, [after]);
  if (!rows.length) break;
  for (const r of rows) {
    after = r.activityid;
    const lat = absolute(r.activitylat as number[], Math.round(r.lat0 * 1e5));
    const lon = absolute(r.activitylon as number[], Math.round(r.lon0 * 1e5));
    const preview = routePreview(lat, lon);
    if (!preview) { skipped++; continue; }
    await client.query('UPDATE activities SET route_preview = $2 WHERE activityid = $1 AND route_preview IS NULL', [r.activityid, JSON.stringify(preview)]);
    done++;
  }
  console.log(`${done} previews made, ${skipped} without a route`);
}
await client.end();
console.log(`done: ${done} previews made, ${skipped} activities without a usable route`);
