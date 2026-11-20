import type { FastifyInstance } from 'fastify';

export interface WalkRow {
  dtgraph: number | null;
  stepcount: number | null;
  distance: number | null;
  ascend: number | null;
  steps_goal: number | null;
  history_base: number | null;
  dtgraph_json: number[] | null;
  stepcount_json: number[] | null;
  ascend_json: number[] | null;
  distance_json: number[] | null;
  iso_json: Array<[string, number]> | null;
}

// docs/data/server.md section 11. The user's `walkdata` row as it is stored, for the restore: today's plain columns and the arrays of completed days (`descend` is not kept by v3). `null` when the user has no row.
// With `history_base` set the arrays are completed days only, deltas against that base; without it (a row from before) they include today and the deltas are against `dtgraph` (docs/data/format.md section 5).
export async function readWalk(app: FastifyInstance, userid: string): Promise<WalkRow | null> {
  const r = await app.pg.reader.query(
    `SELECT dtgraph, stepcount, distance, ascend, steps_goal, history_base, dtgraph_json, stepcount_json, ascend_json, distance_json, iso_json FROM walkdata WHERE userid = $1`,
    [userid],
  );
  return (r.rows[0] as WalkRow | undefined) ?? null;
}
