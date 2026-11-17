-- The feed (docs/data/api.md section 11): a small route for each activity, and an index to read the newest public activities without scanning the table.
-- Run on the local database after 04-migration-v3.sql; the same statements are meant for production later (CONCURRENTLY, outside a transaction).
--   psql -d fitanalytica_dev -f 05-feed-v3.sql

-- A simplified route for a feed card, made by the phone with the same RDP it uses for maps (and by backfill-route-preview for what the phone never sent):
-- {"p": [lat0, lon0, dlat1, dlon1, ...]} in 1e-5 degrees, at most 120 points. NULL for an activity with no track.
ALTER TABLE activities ADD COLUMN route_preview jsonb;

-- Newest first, for the feed: only the rows that can be shown (a deleted marker has tosend = 0).
CREATE INDEX CONCURRENTLY activities_feed ON activities (enddate DESC, activityid DESC) WHERE tosend IN (1, 2);
