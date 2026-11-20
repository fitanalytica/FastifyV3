import { Type } from '@sinclair/typebox';
import { Uuid } from './common.js';

/** The envelope only. The items stay `unknown` on purpose: a bad item is answered `invalid` one by one and must not fail the
 *  whole batch (services/activities/validate.ts). The 1 to 20 items rule is the service's (400 BAD_BATCH). */
export const BatchBodySchema = Type.Object({ activities: Type.Array(Type.Unknown()) });

export const ActivityIdParamsSchema = Type.Object({ activityid: Uuid });

/** `<startdate>.<activityid>`: where the previous page stopped. */
const Cursor = Type.String({ pattern: '^[0-9]{1,10}\\.[0-9a-fA-F-]{36}$' });

/** GET /phone/v3/activities: all of the user's activities, in full, newest first. */
export const RestoreQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 50 })),
  before: Type.Optional(Cursor),
});

/** GET /wearable/v3/activities: the watch's own 50 most recent, once (watch.md section 4). No paging, and no way to ask for anything else. */
export const WearableRestoreQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 50 })),
});

/** GET /phone/v3/feed: the recent activities of public users, a page at a time. `before` is the `next` of the page before: `<local end>.<activityid>`
 *  (the end time on the clock where it happened, which can be negative only for a time before 1970). */
export const FeedQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  before: Type.Optional(Type.String({ pattern: '^-?[0-9]{1,11}\\.[0-9a-fA-F-]{36}$' })),
});

/** GET /phone/v3/media/:activityid/:value. `value` is a file name, as in `media_v2` (`<uuid>.webp`, `<uuid>.mp4`) or an old row's `media`: no slash, so the key
 *  cannot leave the activity's own folder. */
export const MediaParamsSchema = Type.Object({
  activityid: Uuid,
  value: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' }),
});

/** POST /phone/v3/media/:activityid/presign (docs/data/api.md section 6): what is about to be uploaded. */
export const PresignBodySchema = Type.Object({
  role: Type.Union([Type.Literal('photo'), Type.Literal('video'), Type.Literal('poster')]),
  contentType: Type.String({ maxLength: 50 }),
  bytes: Type.Integer({ minimum: 1, maximum: 100 * 1024 * 1024 }),
});

/** A file name the server made: `<uuid>.<ext>`. */
const MediaName = Type.String({ pattern: '^[0-9a-fA-F-]{36}\\.(webp|jpg|mp4)$' });

/** POST /phone/v3/media/:activityid/commit: the file is uploaded; add it to the activity. A video carries its `poster` (uploaded first, never committed alone). */
export const CommitBodySchema = Type.Object({
  value: MediaName,
  type: Type.Union([Type.Literal('photo'), Type.Literal('video')]),
  dimension: Type.Tuple([Type.Integer({ minimum: 1, maximum: 20000 }), Type.Integer({ minimum: 1, maximum: 20000 })]),
  duration: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })),
  poster: Type.Optional(MediaName),
  /** The blur placeholder the phone made: 16 colours (4 x 4) as 96 lower-case hex characters. Stored in the item as it is; the server never reads it. */
  blur: Type.Optional(Type.String({ pattern: '^[0-9a-f]{96}$' })),
});
