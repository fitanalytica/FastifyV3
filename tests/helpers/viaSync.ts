import type { TestApp } from './app.js';
import { bearer } from './fixtures.js';

// The phone's old routes (batch, delete, inbox, ack, device, profile, visibility, location, me/state) are sections of `POST /phone/v3/sync` now (docs/data/sync.md). These helpers make the same calls
// through it and give back what the old route gave (a status and a body), so the tests of what those calls DO (the activity rules, the deletes, the inbox, the profile ...) did not have to change shape.
export interface Resp { statusCode: number; json(): any; body: string; headers: Record<string, unknown> }
export interface Opts { ip?: string; headers?: Record<string, string> }

const STATUS: Record<string, number> = { BAD_REQUEST: 400, BAD_BATCH: 400, NOT_FOUND: 404, UNKNOWN_SECTION: 400 };
const resp = (statusCode: number, body: unknown): Resp => ({ statusCode, json: () => body, body: statusCode === 204 ? '' : JSON.stringify(body), headers: {} });
const failed = (code: string): Resp => resp(STATUS[code] ?? 500, { code, statusCode: STATUS[code] ?? 500 });

/** `POST /phone/v3/sync` with these sections of `up`. */
export const sync = (app: TestApp, token: string | null | undefined, up: unknown, o: Opts = {}) =>
  app.inject({ method: 'POST', url: '/phone/v3/sync', remoteAddress: o.ip, headers: { ...(token ? bearer(token) : {}), ...(o.headers ?? {}) }, payload: { up } as object });

/** The section's answer, or the failed request itself (a token that is refused, a missing token). */
async function section(app: TestApp, token: string | null | undefined, name: string, up: unknown, o?: Opts): Promise<{ res: Resp } | { r: Record<string, any>; down: Record<string, any> }> {
  const res = await sync(app, token, { [name]: up }, o);
  if (res.statusCode !== 200) return { res: res as unknown as Resp };
  const body = res.json();
  return { r: body.results[name], down: body.down };
}

/** The old `POST /activities/batch`: any number of activities (sent 20 at a time); `{ results }`, or 400 `BAD_BATCH` / `BAD_REQUEST` for a list the section refuses. */
export async function phoneBatch(app: TestApp, token: string | null | undefined, activities: unknown, o?: Opts): Promise<Resp> {
  if (!Array.isArray(activities) || activities.length === 0) {
    const got = await section(app, token, 'activities', { send: activities }, o);
    if ('res' in got) return got.res;
    return failed(Array.isArray(activities) ? 'BAD_BATCH' : 'BAD_REQUEST');
  }
  const results: unknown[] = [];
  for (let i = 0; i < activities.length; i += 20) {
    const got = await section(app, token, 'activities', { send: activities.slice(i, i + 20) }, o);
    if ('res' in got) return got.res;
    if (typeof got.r.send === 'string' || !got.r.send) return failed(got.r.code ?? 'UNHANDLED');
    results.push(...got.r.send);
  }
  return resp(200, { results });
}

/** The old `DELETE /activities/:id`: 204, or 404 for an id the server does not have, or 400 for an id that is not one. */
export async function phoneDelete(app: TestApp, token: string | null | undefined, id: string, o?: Opts): Promise<Resp> {
  const got = await section(app, token, 'activities', { delete: [id] }, o);
  if ('res' in got) return got.res;
  const v = got.r.delete?.[id];
  return v === 'ok' ? resp(204, '') : v ? failed(v) : failed(got.r.code ?? 'UNHANDLED');
}

/** The old `GET /activities/inbox`: `{ activities }` (up to 20, oldest first). */
export async function phoneInbox(app: TestApp, token: string | null | undefined, o?: Opts): Promise<Resp> {
  const got = await section(app, token, 'inbox', { pull: true }, o);
  if ('res' in got) return got.res;
  return got.r.ok ? resp(200, got.down.inbox) : failed(got.r.code);
}

/** The old `POST /activities/ack`: `{ acked }`. */
export async function phoneAck(app: TestApp, token: string | null | undefined, ids: unknown, o?: Opts): Promise<Resp> {
  const got = await section(app, token, 'inbox', { ack: ids }, o);
  if ('res' in got) return got.res;
  return got.r.ok ? resp(200, { acked: got.r.ack }) : failed(got.r.code);
}

async function profilePart(app: TestApp, token: string | null | undefined, key: 'put' | 'visibility' | 'location', value: unknown, o?: Opts): Promise<Resp> {
  const got = await section(app, token, 'profile', { [key]: value }, o);
  if ('res' in got) return got.res;
  const v = got.r[key];
  if (v && typeof v === 'object') return resp(200, v);
  return failed(typeof v === 'string' ? v : got.r.code);
}
/** The old `PUT /profile`: the fields as saved. */
export const phoneProfilePut = (app: TestApp, token: string | null | undefined, body: unknown, o?: Opts) => profilePart(app, token, 'put', body, o);
/** The old `PUT /profile/visibility`: `{ hidden }`. */
export const phoneVisibility = (app: TestApp, token: string | null | undefined, hidden: unknown, o?: Opts) => profilePart(app, token, 'visibility', { hidden }, o);
/** The old `PUT /profile/location`: the place as saved. */
export const phoneLocation = (app: TestApp, token: string | null | undefined, body: unknown, o?: Opts) => profilePart(app, token, 'location', body, o);

/** The old `PUT /device`: 204. */
export async function phoneDevice(app: TestApp, token: string | null | undefined, info: unknown, o?: Opts): Promise<Resp> {
  const got = await section(app, token, 'device', info, o);
  if ('res' in got) return got.res;
  return got.r.ok ? resp(204, '') : failed(got.r.code);
}

/** The old `GET /me/state?...`: the state (the query is what the phone holds: `catalog`, `ads`, `platform`). */
export async function phoneState(app: TestApp, token: string | null | undefined, query: Record<string, unknown> = {}, o?: Opts): Promise<Resp> {
  const got = await section(app, token, 'state', query, o);
  if ('res' in got) return got.res;
  return got.r.ok ? resp(200, got.down.state) : failed(got.r.code);
}

/** The old `GET /activities?limit=&before=` of the phone: a restore page `{ activities, next, total }`, as the restore part of the sync call gives it. */
export async function phoneRestore(app: TestApp, token: string | null | undefined, query: { limit?: number; before?: string } = {}, o?: Opts): Promise<Resp> {
  const res = await app.inject({ method: 'POST', url: '/phone/v3/sync', remoteAddress: o?.ip, headers: { ...(token ? bearer(token) : {}), ...(o?.headers ?? {}) }, payload: { restore: { activities: query } } as object });
  if (res.statusCode !== 200) return res as unknown as Resp;
  const body = res.json();
  return body.results.restore.ok ? resp(200, body.down.restore.activities) : failed(body.results.restore.code);
}

/** A phone-route call with nothing to send: 200 for a token the phone route accepts, else the refusal (the stand-in for the old `GET /me` as a check of a token). */
export const probe = (app: TestApp, token: string | null | undefined, o?: Opts) => sync(app, token, {}, o);
/** The same for the watch's group (its list of activities, one row). */
export const probeWatch = (app: TestApp, token: string) => app.inject({ url: '/wearable/v3/activities?limit=1', headers: bearer(token) });
/** Whose phone token it is: its user and the kind of device (the old `GET /me`'s answer), found by marking the token's own install through the `device` section. Another status than 200: the refusal itself. */
export async function whoami(app: TestApp, token: string): Promise<Resp | { userid: string; deviceType: string }> {
  const marker = 'w' + Math.random().toString(36).slice(2, 10);   // the install's `device_os` keeps 10 characters
  const res = await sync(app, token, { device: { os: marker } });
  if (res.statusCode !== 200) return res as unknown as Resp;
  const row = (await app.pg.writer.query('SELECT userid, device_type::text AS device_type FROM downloads WHERE device_os = $1', [marker])).rows[0];
  await app.pg.writer.query('UPDATE downloads SET device_os = NULL WHERE device_os = $1', [marker]);
  return { userid: row.userid, deviceType: row.device_type };
}
