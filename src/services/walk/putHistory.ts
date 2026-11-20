import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { WalkHistoryBody } from '../../types/index.js';

const DAY = 86400;

// docs/data/server.md section 11. The arrays of completed days, stored as received (the server decodes nothing; it only checks that they line up). `descend_json` is not kept. If the user has no row
// yet (history before the first `PUT /walk/today`), one is made with `dtgraph = base`.
export async function putWalkHistory(app: FastifyInstance, userid: string, body: WalkHistoryBody): Promise<void> {
  const n = body.stepcount_json.length;
  const runs = body.iso_json.reduce((sum, [, count]) => sum + count, 0);
  if (body.base % DAY !== 0) throw errors.BadRequest('base is not a day label', ErrorCode.BAD_HISTORY);
  if (body.dtgraph_json.length !== n || body.ascend_json.length !== n || body.distance_json.length !== n || runs !== n) {
    throw errors.BadRequest('the arrays do not line up', ErrorCode.BAD_HISTORY);
  }
  await app.pg.writer.query(
    `INSERT INTO walkdata (userid, dtgraph, history_base, dtgraph_json, stepcount_json, ascend_json, distance_json, iso_json)
     VALUES ($1, $2, $2, $3::json, $4::json, $5::json, $6::json, $7::json)
     ON CONFLICT (userid) DO UPDATE SET history_base = EXCLUDED.history_base, dtgraph_json = EXCLUDED.dtgraph_json, stepcount_json = EXCLUDED.stepcount_json,
       ascend_json = EXCLUDED.ascend_json, distance_json = EXCLUDED.distance_json, iso_json = EXCLUDED.iso_json`,
    [userid, body.base, ...[body.dtgraph_json, body.stepcount_json, body.ascend_json, body.distance_json, body.iso_json].map(a => JSON.stringify(a))],
  );
}
