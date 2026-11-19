import type { FastifyInstance } from 'fastify';

// docs/data/api.md section 15. The user's `store_id`: the account token the app puts on every purchase, so the App Store's notification can say whose it is even when the phone never reported
// it. New profiles get one when they are made; a profile from before that has none and is given one here, once (a second call finds it). `null` while there is no profile row yet.
export async function accountToken(app: FastifyInstance, userid: string): Promise<string | null> {
  const made = await app.pg.writer.query<{ store_id: string }>('UPDATE userinfo SET store_id = gen_random_uuid() WHERE userid = $1 AND store_id IS NULL RETURNING store_id', [userid]);
  if (made.rows[0]) return made.rows[0].store_id;
  const r = await app.pg.writer.query<{ store_id: string | null }>('SELECT store_id FROM userinfo WHERE userid = $1', [userid]);
  return r.rows[0]?.store_id ?? null;
}
