import type { FastifyInstance } from 'fastify';
import type { AckResponse } from '../../types/index.js';
import { ACTIVITY_OUT } from './columns.js';

// docs/data/server.md section 5. Read from the writer, not the reader: the phone repeats "fetch, ack" until the inbox is empty,
// and a lagging reader could hand back an item that was just acknowledged. It is a few rows on a small partial index (activities_inbox).
const INBOX = `
  SELECT json_build_object('activities', coalesce(json_agg(t ORDER BY t.startdate, t.activityid), '[]'::json))::text AS body
    FROM (SELECT ${ACTIVITY_OUT} FROM activities
           WHERE userid = $1 AND tosend = 2 ORDER BY startdate, activityid LIMIT $2) t`;

/** The user's watch activities the phone has not seen, oldest first, as JSON **text**: the large arrays are never parsed and
 *  re-written here, the server only passes them on. */
export async function inboxActivities(app: FastifyInstance, userid: string, limit: number): Promise<string> {
  const r = await app.pg.writer.query(INBOX, [userid, limit]);
  return r.rows[0].body as string;
}

/** The phone has stored these: they leave the inbox. Only ids that are the user's and still waiting count. */
export async function ackActivities(app: FastifyInstance, userid: string, ids: string[]): Promise<AckResponse> {
  const r = await app.pg.writer.query(
    'UPDATE activities SET tosend = 1 WHERE activityid = ANY($1::uuid[]) AND userid = $2 AND tosend = 2 RETURNING activityid',
    [ids, userid]);
  return { acked: r.rows.map((x) => x.activityid as string) };
}
