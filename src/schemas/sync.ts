import { Type } from '@sinclair/typebox';
import { DeviceInfoSchema } from './auth.js';
import { LocationBodySchema, ProfileBodySchema } from './profile.js';
import { StateQuerySchema } from './store.js';
import { WalkHistoryBodySchema, WalkTodayBodySchema } from './walk.js';

/**
 * POST /phone/v3/sync (docs/data/sync.md): the envelope only. The sections of `up` are checked **one by one inside the call** (so a bad section fails alone, in `results`, and does not refuse the others),
 * which is why `up` is a free map here. `have` (the versions the phone holds) and `restore` are accepted now and used when the sections that read are built.
 */
export const SyncBodySchema = Type.Object({
  up: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  have: Type.Optional(Type.Record(Type.String(), Type.String())),
  restore: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/**
 * The `activities` section of `up` (docs/data/sync.md): `send` is the batch of docs/data/api.md section 2 (the compact items, 1 to 20; each is checked by the activity code, which answers per item) and `delete` the
 * ids of activities the user deleted (up to 20).
 */
export const ActivitiesUpSchema = Type.Object(
  { send: Type.Optional(Type.Array(Type.Unknown(), { minItems: 1, maxItems: 20 })), delete: Type.Optional(Type.Array(Type.String({ pattern: '^[0-9a-fA-F-]{36}$' }), { minItems: 1, maxItems: 20 })) },
  { additionalProperties: false },
);

const ActivityId = Type.String({ pattern: '^[0-9a-fA-F-]{36}$' });

/**
 * The `inbox` section of `up` (docs/data/sync.md): `ack` are the watch activities the phone has stored (they leave the inbox; up to 100), and `pull` asks for the next ones waiting (up to 20,
 * oldest first), which come back in `down.inbox`. Acks are applied before the pull, so a pulled item is never one just acknowledged.
 */
export const InboxUpSchema = Type.Object({ ack: Type.Optional(Type.Array(ActivityId, { minItems: 1, maxItems: 100 })), pull: Type.Optional(Type.Boolean()) }, { additionalProperties: false });

/** The `state` section of `up` is a read: the versions of the catalogue and of the ad rules the phone holds, and its platform; each comes back whole in `down.state` only when it changed (docs/data/api.md section 15). */
export const StateUpSchema = StateQuerySchema;

/** The `profile` section of `up`: `put` the fields that changed (docs/data/api.md section 7), `visibility` (`hidden` true is private) and `location` (a fix from the phone's GPS). */
export const ProfileUpSchema = Type.Object(
  { put: Type.Optional(ProfileBodySchema), visibility: Type.Optional(Type.Object({ hidden: Type.Boolean() }, { additionalProperties: false })), location: Type.Optional(LocationBodySchema) },
  { additionalProperties: false, minProperties: 1 },
);

/** The `device` section of `up`: what changed about this phone (docs/data/api.md section 1d). */
export const DeviceUpSchema = DeviceInfoSchema;

/**
 * `restore` of the sync call (docs/data/sync.md section 5): what a new phone, or a new sign-in, takes from the server. `walk` asks for the step history (the whole `walkdata` row); `activities` for a page of the
 * user's activities in full, newest first, after the cursor `before` (the `next` of the page before), `limit` of them (up to 300; the page is also cut to fit about 1.5 MB). More kinds join here (plan).
 */
export const RestoreUpSchema = Type.Object(
  {
    walk: Type.Optional(Type.Boolean()),
    /** The streak to carry on, the ones before it and the protection days earned and not spent (docs/data/sync.md section 5). */
    streak: Type.Optional(Type.Boolean()),
    /** The running plan to carry on (the active one, else the latest that ended) with its decided weeks (docs/data/sync.md section 4h). */
    plan: Type.Optional(Type.Boolean()),
    activities: Type.Optional(
      Type.Object({ before: Type.Optional(Type.String({ pattern: '^[0-9]{1,10}\\.[0-9a-fA-F-]{36}$' })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

/**
 * The `distanceRank` section of `up` (docs/data/sync.md section 4i): a read for Activity stats' Ranking card. `keys` is the label of the first day of the user's current week, month and year (the local date as UTC midnight, seconds):
 * the server adds up the user's distance from its `activities` table under them and ranks it. All time has no key.
 */
export const DistanceRankUpSchema = Type.Object(
  { keys: Type.Object({ Week: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }), Month: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }), Year: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }) }, { additionalProperties: false }) },
  { additionalProperties: false },
);

/** The `walk` section of `up`: the two bodies of docs/data/api.md section 10, either or both. */
export const WalkUpSchema = Type.Object({ today: Type.Optional(WalkTodayBodySchema), history: Type.Optional(WalkHistoryBodySchema) }, { additionalProperties: false });

/** The `challengers` section of `up` is a read (docs/data/sync.md section 4c): the step challengers of today. `steps` is the user's total today, counted on the phone, and `day` the label of today (the local date as UTC midnight): the server stores them as the Day total and answers with today's first eight. */
export const ChallengersUpSchema = Type.Object(
  { steps: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })), day: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_102_444_800 })) },
  { additionalProperties: false },
);

/** The `streakLeaders` section of `up` is a read (docs/data/sync.md section 4d): the streak leaderboard window. The user's days come from the streak the phone sent (`days` is ignored). */
export const StreakLeadersUpSchema = Type.Object({ days: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })) }, { additionalProperties: false });

/** A UUID as text: checked by pattern, because a section is checked with `Value.Check`, which has no `uuid` format. */
const IdSchema = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
const DayLogSchema = Type.Object(
  { s: Type.Integer({ minimum: 0, maximum: 1_000_000 }), r: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })), r_t: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })), p: Type.Optional(Type.Literal(true)), n: Type.Optional(Type.Literal(true)) },
  { additionalProperties: false },
);
/** One streak as `streak_logs` keeps it (docs/data/sync.md section 4g). `daily_logs` is a list of levels, each with its days in order from `start_date`: `s` steps, `r` minutes run, `r_t` the run's target, `p` a protection day, `n` a day with no step data (it counts for nothing). */
const StreakBodySchema = Type.Object(
  {
    streak_id: IdSchema,
    level_id: IdSchema,
    start_date: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }),
    end_date: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_102_444_800 })),
    goal: Type.Integer({ minimum: 1000, maximum: 100_000 }),
    status: Type.Union([Type.Literal('in_progress'), Type.Literal('completed'), Type.Literal('failed')]),
    daily_logs: Type.Array(Type.Object({ level_id: IdSchema, logs: Type.Array(DayLogSchema, { maxItems: 4000 }) }, { additionalProperties: false }), { maxItems: 20 }),
  },
  { additionalProperties: false },
);
/** The `streak` section of `up`: the streaks that changed (the running one, and one that has just ended). `duration` and `protection_used` are not sent: the server works them out from the days. */
export const StreakUpSchema = Type.Object({ streaks: Type.Array(StreakBodySchema, { minItems: 1, maxItems: 5 }) }, { additionalProperties: false });

const Day = { minimum: 0, maximum: 4_102_444_800 };
/** One decided week of a plan: `[the plan week it counted as, outcome, its seven days from Sunday]`. Outcome: `o` on track, `r` the week repeats, `b` back one, `p` paused. Days: `R`/`L` run and long run done, `r`/`l` missed, `.` rest, `-` outside the plan or paused. */
const PlanWeekSchema = Type.Tuple([Type.Integer({ minimum: 0, maximum: 400 }), Type.Union([Type.Literal('o'), Type.Literal('r'), Type.Literal('b'), Type.Literal('p')]), Type.String({ pattern: '^[RLrl.-]{7}$' })]);
/**
 * The `plan` section of `up` (docs/data/sync.md section 4h): the running plan as one row of `run_plans`. The answers, the builder's version and the length are written once; `weeks` come as `weeks_from` (the place of the first
 * of them) and are only appended; `ended_on` is set once; the run days, tuning and pause are replaced when `settings_at` is not older than the held one.
 */
export const PlanUpSchema = Type.Object(
  {
    plan: Type.Object(
      {
        plan_id: IdSchema,
        started_on: Type.Integer(Day),
        race_on: Type.Optional(Type.Integer(Day)),
        ended_on: Type.Optional(Type.Integer(Day)),
        longest_run: Type.Integer({ minimum: 0, maximum: 3 }),
        distance: Type.Integer({ minimum: 0, maximum: 3 }),
        gen: Type.Integer({ minimum: 1, maximum: 1000 }),
        total_weeks: Type.Integer({ minimum: 1, maximum: 400 }),
        run_days: Type.Integer({ minimum: 0, maximum: 127 }),
        long_day: Type.Integer({ minimum: 0, maximum: 6 }),
        pace_delta: Type.Integer({ minimum: -600, maximum: 600 }),
        volume_pm: Type.Integer({ minimum: 0, maximum: 100 }),
        tuned_from_week: Type.Optional(Type.Integer({ minimum: 0, maximum: 400 })),
        paused_until: Type.Optional(Type.Integer(Day)),
        settings_at: Type.Integer(Day),
        weeks_from: Type.Integer({ minimum: 0, maximum: 400 }),
        weeks: Type.Array(PlanWeekSchema, { maxItems: 400 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** The `streakConfig` section of `up` is a read (docs/data/sync.md section 4f): the version of the levels and notification texts the phone holds; the content comes back whole only when it changed. */
export const StreakConfigUpSchema = Type.Object({ version: Type.Optional(Type.String({ pattern: '^[0-9a-f]{12}$' })) }, { additionalProperties: false });

/** The `feedScrub` section of `up` (docs/data/sync.md section 4e): the ids of the posts and activities the phone keeps in its feed cache; the answer says which of them are no longer in the feed for this user. */
export const FeedScrubUpSchema = Type.Object(
  { ids: Type.Array(Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }), { maxItems: 500 }) },
  { additionalProperties: false },
);

/**
 * The `rank` section of `up` (docs/data/sync.md section 4b): it asks for the user's place on the step leaderboards (Day, Week, Month, Year, All time: the current one of each). `steps` are the user's own totals for
 * those periods, counted on the phone, and `keys` the label of each period's first day (the local date as UTC midnight, seconds; all time has none): the server stores the totals under them and ranks them.
 */
export const RankUpSchema = Type.Object(
  { steps: Type.Optional(Type.Object({ Day: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), Week: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), Month: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), Year: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), 'All time': Type.Integer({ minimum: 0, maximum: 1_000_000_000 }) }, { additionalProperties: false })),
    keys: Type.Optional(Type.Object({ Day: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }), Week: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }), Month: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }), Year: Type.Integer({ minimum: 0, maximum: 4_102_444_800 }) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);
