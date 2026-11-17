import type { FastifyInstance } from 'fastify';

// Photos and videos belong to an activity or to a post (docs/data/api.md sections 6 and 12). The routes take one id; the ids are random UUIDs, so an id is in
// at most one of the two tables. What differs between them is only the table and its id column, never a request value, so they are joined into SQL as fixed words.

export type OwnerKind = 'activity' | 'post';

export const OWNER_TABLE: Record<OwnerKind, { table: string; id: string }> = {
  activity: { table: 'activities', id: 'activityid' },
  post: { table: 'posts', id: 'postid' },
};

const OWNS = `
  SELECT 'activity' AS kind FROM activities WHERE activityid = $1 AND userid = $2 AND tosend > 0
  UNION ALL
  SELECT 'post' FROM posts WHERE postid = $1 AND userid = $2 AND tosend > 0`;

/** What `id` is, if the user owns it and it is not deleted; else undefined. Asked of the writer: the item may have been uploaded a moment ago. */
export async function ownerKind(app: FastifyInstance, userid: string, id: string): Promise<OwnerKind | undefined> {
  return (await app.pg.writer.query(OWNS, [id, userid])).rows[0]?.kind as OwnerKind | undefined;
}
