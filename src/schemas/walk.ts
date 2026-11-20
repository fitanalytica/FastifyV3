import { Type } from '@sinclair/typebox';

const Count = Type.Integer({ minimum: 0, maximum: 2_000_000 });
const Metres = Type.Number({ minimum: 0, maximum: 10_000_000 });
const Floors = Type.Integer({ minimum: 0, maximum: 32_000 });
const Label = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
const MAX_DAYS = 6000;

/**
 * PUT /phone/v3/walk/today: today's plain columns, stored as received (docs/data/api.md section 10). **No floors down** (`descend` is not sent or kept by v3). `yesterday` is the day before (`dtgraph - 86400`), for yesterday's leaderboard; its three
 * values come together.
 */
export const WalkTodayBodySchema = Type.Object({
  dtgraph: Label,
  stepcount: Count,
  distance: Metres,
  ascend: Floors,
  max_steps: Count,
  max_steps_date: Label,
  max_distance: Metres,
  max_distance_date: Label,
  steps_goal: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  yesterday: Type.Optional(Type.Object({ dtgraph: Label, stepcount: Count, distance: Metres })),
});

/**
 * PUT /phone/v3/walk/history: the arrays of completed days, oldest first, one entry per day with steps (docs/data/format.md section 5). `base` is the day the deltas of `dtgraph_json` were encoded against.
 * **There is no `descend_json`** (floors down are kept for today only) and no coordinates. `iso_json` is run-length encoded: `[["IN",328],["TR",15]]`.
 */
export const WalkHistoryBodySchema = Type.Object({
  base: Label,
  dtgraph_json: Type.Array(Type.Integer({ minimum: 0, maximum: 100_000 }), { maxItems: MAX_DAYS }),
  stepcount_json: Type.Array(Count, { maxItems: MAX_DAYS }),
  ascend_json: Type.Array(Floors, { maxItems: MAX_DAYS }),
  distance_json: Type.Array(Metres, { maxItems: MAX_DAYS }),
  iso_json: Type.Array(Type.Tuple([Type.String({ pattern: '^[A-Z]{2}$' }), Type.Integer({ minimum: 1, maximum: MAX_DAYS })]), { maxItems: MAX_DAYS }),
});
