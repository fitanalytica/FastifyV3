// The columns of an activity as the server sends it to a device (see START below for `lat` and `lon`).
// Built from four parts so the lists can never drift from each other.

/** The start point. A NEW-format row (activitydetail_v2 present) gets the exact doubles from `geom`, which its compact arrays are relative to.
 *  An OLD-format row gets the `lat` and `lon` columns, never `geom`: in production some old rows have `geom` swapped (lat, lon) or (0, 0)
 *  (one real account: 12 of 85), because several old code paths built it wrongly. format.md section 2. */
const START = `CASE WHEN activitydetail_v2 IS NOT NULL THEN ST_Y(geom) ELSE lat::text::float8 END AS lat,
  CASE WHEN activitydetail_v2 IS NOT NULL THEN ST_X(geom) ELSE lon::text::float8 END AS lon`;
// (`::text::float8`: a bare REAL widened to double would print as 19.11927032470703; through text it stays 19.11927.)

/** The small fields. `activitydetail_v2` holds the time zone (`tz`), the media list is small. */
const SUMMARY = `activityid, downloadid, startdate, enddate, dtgraph, ${START},
  temp, realfeel, humidity, duration, stepcount, distance, wind, uvi, iso, weathericon, weather, city, state, aqi,
  iswatch, description, activitydetail_v2, device, media_v2`;
/** The track: the large arrays. */
const TRACK = `activitybpm_v2, activitylat, activitylon, activitytimenow, activityelevation, activitydistance`;
/** Old-format rows (written by the old app) keep their media here; small. */
const OLD_SMALL = `media, media_details`;
/** Old-format rows: the per-point speed class and the old heart rate; large. */
const OLD_TRACK = `activitydetail, activitybpm`;

/** A new-format row in full (the inbox: watch rows are always new-format). */
export const ACTIVITY_OUT = `${SUMMARY}, ${TRACK}`;
/** Everything, old-format columns included. For restore pages. */
export const ACTIVITY_FULL = `${SUMMARY}, ${TRACK}, ${OLD_SMALL}, ${OLD_TRACK}`;
