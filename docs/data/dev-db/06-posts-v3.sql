-- Posts: what a user shares from Home (a template of the day's steps and/or distance, photos and videos, a title and a description), docs/data/api.md section 12.
-- Run on the local database after 05-feed-v3.sql; the same statements are meant for production later (CONCURRENTLY, outside a transaction).
--   psql -d fitanalytica_dev -f 06-posts-v3.sql

CREATE TABLE posts (
  postid    UUID PRIMARY KEY,                                    -- made on the phone, so a repeated upload changes nothing
  userid    UUID NOT NULL REFERENCES userlogin(userid) ON DELETE CASCADE,
  posted_at INTEGER NOT NULL,                                    -- epoch seconds, a real instant: the feed's order
  tosend    SMALLINT NOT NULL DEFAULT 1,                         -- 1 = live, 0 = deleted (a marker, like activities)
  content   JSONB NOT NULL DEFAULT '{}'::jsonb,                  -- { v, template?, steps?, distance?, dtgraph?, title?, description? } (format.md section 7)
  media_v2  JSONB NOT NULL DEFAULT '[]'::jsonb,                  -- the photos and videos, the same items as an activity's (format.md section 4)
  ddate     INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())),
  CONSTRAINT posts_tosend CHECK (tosend IN (0, 1)),
  CONSTRAINT posts_media_is_list CHECK (jsonb_typeof(media_v2) = 'array')
);

-- The feed (newest first) and a user's own restore read live posts in time order.
CREATE INDEX posts_feed ON posts (posted_at DESC, postid DESC) WHERE tosend = 1;
CREATE INDEX posts_user ON posts (userid, posted_at DESC, postid DESC) WHERE tosend = 1;
