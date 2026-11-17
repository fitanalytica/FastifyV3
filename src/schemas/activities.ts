import { Type } from '@sinclair/typebox';
import { Uuid } from './common.js';

/** The envelope only. The items stay `unknown` on purpose: a bad item is answered `invalid` one by one and must not fail the
 *  whole batch (services/activities/validate.ts). The 1 to 20 items rule is the service's (400 BAD_BATCH). */
export const BatchBodySchema = Type.Object({ activities: Type.Array(Type.Unknown()) });

export const ActivityIdParamsSchema = Type.Object({ activityid: Uuid });

export const InboxQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
});

export const AckBodySchema = Type.Object({ ids: Type.Array(Uuid, { minItems: 1, maxItems: 100 }) });

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
