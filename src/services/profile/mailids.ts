import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// docs/data/api.md section 7. The user's `mailids`: 11 letters and digits, made once when the profile row is made and never changed. The app puts it in the subject of the support email
// ("Ref:...") so support can find the account without the account id. A row from before it existed is given one the first time the profile is read.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const MAILIDS_LENGTH = 11;

/** A new reference of 11 letters and digits (62^11 of them, so two users do not share one). */
export function generateMailids(): string {
  let id = '';
  for (let i = 0; i < MAILIDS_LENGTH; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

/** Gives the user a reference if the row has none (an older row); a row that has one is never touched. Returns the reference the row has now. */
export async function ensureMailids(app: FastifyInstance, userid: string): Promise<string | null> {
  const made = await app.pg.writer.query<{ mailids: string }>('UPDATE userinfo SET mailids = $2 WHERE userid = $1 AND mailids IS NULL RETURNING mailids', [userid, generateMailids()]);
  if (made.rows[0]) return made.rows[0].mailids;
  const had = await app.pg.writer.query<{ mailids: string | null }>('SELECT mailids FROM userinfo WHERE userid = $1', [userid]);
  return had.rows[0]?.mailids ?? null;
}
