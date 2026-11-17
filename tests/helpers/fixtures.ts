import { randomUUID } from 'node:crypto';
import type { TestApp } from './app.js';

export const PHONE_BATCH = '/phone/v3/activities/batch';
export const WEARABLE_BATCH = '/wearable/v3/activities/batch';

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A valid activity as the app sends it, with a fresh id. `over` replaces or adds fields. */
export function activity(downloadid: string, over: Record<string, unknown> = {}) {
  return {
    activityid: randomUUID(), userid: randomUUID() /* ignored by the server */,
    startdate: 1731480000, enddate: 1731483600, duration: 3600, stepcount: 8123, distance: 9210,
    lat: 12.971599, lon: 77.594566, downloadid, iswatch: false, city: 'Bengaluru', iso: 'IN',
    activitydetail_v2: { enc: 1, tz: 19800, breaks: [] }, activitylat: [0, 12, 15], activitylon: [0, -4, -3],
    activitytimenow: [1731480000, 1, 2], activityelevation: [903.4, 903.4, 903.5], activitydistance: [0, 3.1, 6.0],
    activitybpm_v2: null, media_v2: [], description: 'morning run', ...over,
  };
}

/** The stored row, with the point split into gx (longitude) and gy (latitude). */
export async function activityRow(app: TestApp, activityid: string) {
  const r = await app.pg.writer.query('SELECT *, geom[0] AS gx, geom[1] AS gy FROM activities WHERE activityid = $1', [activityid]);
  return r.rows[0];
}
