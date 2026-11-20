import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import type { WalkTodayBody } from '../../types/index.js';

const DAY = 86400;

// docs/data/server.md section 11. Today's fixed-size columns only, stored as received: the large JSON columns are not rewritten. `dtgraph` is a date label (midnight UTC), and a local date is at most
// about 14 hours from UTC, so it is within one day of the server's UTC date; no time zone is needed. `yesterday`, if sent, is exactly `dtgraph - 86400`. A row is made on the first call.
export async function putWalkToday(app: FastifyInstance, userid: string, body: WalkTodayBody, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  if (body.dtgraph % DAY !== 0 || Math.abs(body.dtgraph - Math.floor(now / DAY) * DAY) > DAY) {
    throw errors.BadRequest('dtgraph is not a day within a day of today', ErrorCode.BAD_DTGRAPH);
  }
  const y = body.yesterday;
  if (y && y.dtgraph !== body.dtgraph - DAY) throw errors.BadRequest('yesterday is not the day before dtgraph', ErrorCode.BAD_YESTERDAY);
  await app.pg.writer.query(
    `INSERT INTO walkdata (userid, dtgraph, stepcount, distance, ascend, max_steps, max_steps_date, max_distance, max_distance_date, steps_goal,
                           yesterday_dtgraph, yesterday_stepcount, yesterday_distance, ddate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (userid) DO UPDATE SET
       dtgraph = EXCLUDED.dtgraph, stepcount = EXCLUDED.stepcount, distance = EXCLUDED.distance, ascend = EXCLUDED.ascend,
       max_steps = EXCLUDED.max_steps, max_steps_date = EXCLUDED.max_steps_date, max_distance = EXCLUDED.max_distance, max_distance_date = EXCLUDED.max_distance_date,
       steps_goal = EXCLUDED.steps_goal, ddate = EXCLUDED.ddate,
       yesterday_dtgraph   = COALESCE(EXCLUDED.yesterday_dtgraph,   walkdata.yesterday_dtgraph),
       yesterday_stepcount = COALESCE(EXCLUDED.yesterday_stepcount, walkdata.yesterday_stepcount),
       yesterday_distance  = COALESCE(EXCLUDED.yesterday_distance,  walkdata.yesterday_distance)`,
    [userid, body.dtgraph, body.stepcount, body.distance, body.ascend, body.max_steps, body.max_steps_date, body.max_distance, body.max_distance_date, body.steps_goal,
      y?.dtgraph ?? null, y?.stepcount ?? null, y?.distance ?? null, now],
  );
}
