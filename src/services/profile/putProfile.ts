import type { FastifyInstance } from 'fastify';
import type { ProfileBody } from '../../types/index.js';

// docs/data/api.md section 7. The fields the user edits in Edit profile (and the new-user setup), any of them: the profile row is made on the first call, and
// every later call changes only the fields it carries (the last write wins). The new row also gets its `store_id`, the account token the app puts on its purchases
// (docs/data/api.md section 15); a row that has none is given one when the phone asks for its state. The column names below are the only ones that can reach the SQL; the values
// always go through parameters.
const FIELDS = ['fname', 'lname', 'about', 'gender', 'dobglobal', 'height', 'weight'] as const;
type Field = (typeof FIELDS)[number];
const CAST: Partial<Record<Field, string>> = { gender: '::gender_enum' };

export type SavedProfile = Pick<ProfileBody, Field>;

/** Saves the fields and answers them as saved. A text is trimmed, and an empty one is cleared. */
export async function putProfile(app: FastifyInstance, userid: string, body: ProfileBody): Promise<SavedProfile> {
  const keys = FIELDS.filter((k) => body[k] !== undefined);
  const value = (k: Field) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() || null : v;
  };
  const params: unknown[] = [userid, Math.floor(Date.now() / 1000), ...keys.map(value)];
  const marks = keys.map((k, i) => `$${i + 3}${CAST[k] ?? ''}`);
  const sql = `
    INSERT INTO userinfo (userid, dateregistered, store_id, ${keys.join(', ')}) VALUES ($1, $2, gen_random_uuid(), ${marks.join(', ')})
    ON CONFLICT (userid) DO UPDATE SET ${keys.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
    RETURNING fname, lname, about, gender, dobglobal, height, weight`;
  const r = await app.pg.writer.query(sql, params);
  return r.rows[0];
}
