import { Type } from '@sinclair/typebox';
import { Uuid } from './common.js';

export const PostIdParamsSchema = Type.Object({ postid: Uuid });

/** What a post says (docs/data/format.md section 7). Kept as JSON so a field can be added without a migration; the server checks it here and stores it. */
export const PostContentSchema = Type.Object(
  {
    /** The version of this shape. */
    v: Type.Literal(1),
    template: Type.Optional(Type.Union([Type.Literal('steps'), Type.Literal('distance'), Type.Literal('steps_distance')])),
    /** The day's steps at the moment of sharing. */
    steps: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    /** The day's distance in metres at the moment of sharing. */
    distance: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
    /** The day those numbers belong to (a date as midnight UTC, README section 5). */
    dtgraph: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_102_444_800 })),
    title: Type.Optional(Type.String({ maxLength: 120 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);

/**
 * PUT /phone/v3/posts/:postid: make the post, or change what it says (docs/data/api.md section 12). `media` is how many photos and videos the phone is
 * about to upload (they come after, one at a time): a post with no text is only allowed when it says it has media coming.
 */
export const PutPostBodySchema = Type.Object({
  posted_at: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  content: PostContentSchema,
  media: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
});

/** GET /phone/v3/posts: the user's own posts, newest first. `before` is `<posted_at>.<postid>`. */
export const PostsQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 50 })),
  before: Type.Optional(Type.String({ pattern: '^[0-9]{1,10}\\.[0-9a-fA-F-]{36}$' })),
});
