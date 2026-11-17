import { Type } from '@sinclair/typebox';
import { Uuid } from './common.js';

export const UserIdParamsSchema = Type.Object({ userid: Uuid });

/** GET /phone/v3/users/:userid/feed: `kind` picks activities or posts (both when missing); `media` keeps only those with photos or videos. */
export const UserFeedQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  before: Type.Optional(Type.String({ pattern: '^-?[0-9]{1,11}\\.[0-9a-fA-F-]{36}$' })),
  kind: Type.Optional(Type.Union([Type.Literal('activity'), Type.Literal('post')])),
  media: Type.Optional(Type.Boolean()),
});
