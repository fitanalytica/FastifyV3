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
 * user's activities in full, newest first, after the cursor `before` (the `next` of the page before), `limit` of them (up to 300; the page is also cut to fit about 1.5 MB). More kinds join here (streak, plan).
 */
export const RestoreUpSchema = Type.Object(
  {
    walk: Type.Optional(Type.Boolean()),
    activities: Type.Optional(
      Type.Object({ before: Type.Optional(Type.String({ pattern: '^[0-9]{1,10}\\.[0-9a-fA-F-]{36}$' })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

/** The `walk` section of `up`: the two bodies of docs/data/api.md section 10, either or both. */
export const WalkUpSchema = Type.Object({ today: Type.Optional(WalkTodayBodySchema), history: Type.Optional(WalkHistoryBodySchema) }, { additionalProperties: false });

/** The `challengers` section of `up` is a read (docs/data/sync.md section 4c): the step challengers of today. `steps` is the user's total today, counted on the phone; only used while the leaderboard is **dummy**. */
export const ChallengersUpSchema = Type.Object({ steps: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })) }, { additionalProperties: false });

/**
 * The `rank` section of `up` is a read (docs/data/sync.md section 4b): it asks for the user's place on the step leaderboards (Day, Week, Month, Year, All time: the current one of each). `steps` are the user's own totals for
 * those periods, counted on the phone; they are only used while the leaderboard is **dummy** (the server then has nothing of its own to compare), and go when it is real.
 */
export const RankUpSchema = Type.Object(
  { steps: Type.Optional(Type.Object({ Day: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), Week: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), Month: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), Year: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }), 'All time': Type.Integer({ minimum: 0, maximum: 1_000_000_000 }) }, { additionalProperties: false })) },
  { additionalProperties: false },
);
