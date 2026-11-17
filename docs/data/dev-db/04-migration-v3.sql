-- The changes of docs/data/schema.pg.md section 8 (without the housekeeping drops, which come last).
-- Run on the local database after 03-schema-current.sql; the same statements are meant for production later.
--   psql -d fitanalytica_dev -f 04-migration-v3.sql

-- 1. activities: the new columns, and tosend with its three values
ALTER TABLE activities
  ADD COLUMN activitydetail_v2 json,
  ADD COLUMN activitybpm_v2 json,
  ADD COLUMN media_v2 jsonb DEFAULT '[]'::jsonb;
COMMENT ON COLUMN activities.tosend IS '1 phone has it, 2 watch uploaded and phone has not acked, 0 deleted';
ALTER TABLE activities ADD CONSTRAINT activities_tosend_ck CHECK (tosend IN (0, 1, 2)) NOT VALID;
ALTER TABLE activities VALIDATE CONSTRAINT activities_tosend_ck;

-- 2. activities: indexes
CREATE INDEX CONCURRENTLY activities_user_start ON activities (userid, startdate DESC, activityid DESC) WHERE tosend > 0;
CREATE INDEX CONCURRENTLY activities_user_watch_start ON activities (userid, startdate DESC) WHERE iswatch AND tosend > 0;
CREATE INDEX CONCURRENTLY activities_inbox ON activities (userid) WHERE tosend = 2;

-- 3. userinfo: location
ALTER TABLE userinfo ADD COLUMN geo_source smallint;
ALTER TABLE userinfo ALTER COLUMN geom DROP NOT NULL;
ALTER TABLE userinfo ADD CONSTRAINT userinfo_geo_source_ck CHECK (geo_source IN (1, 2));

-- 4. walkdata: the base the history arrays were encoded against
ALTER TABLE walkdata ADD COLUMN history_base integer;
-- the previous day, for yesterday's leaderboard (the plain columns move on to the new day at the next sync)
ALTER TABLE walkdata ADD COLUMN yesterday_dtgraph integer, ADD COLUMN yesterday_stepcount integer, ADD COLUMN yesterday_distance real;
CREATE INDEX CONCURRENTLY idx_walkdata_yesterday_stepcount ON walkdata (yesterday_dtgraph, yesterday_stepcount DESC) WHERE yesterday_dtgraph IS NOT NULL;

-- 5. usertokens: one row per device, and the refresh grace
ALTER TABLE usertokens DROP CONSTRAINT unique_applegoogle_device;
DROP INDEX IF EXISTS idx_usertokens_applegoogleid_device;
ALTER TABLE usertokens ADD COLUMN prev_refresh_token char(64), ADD COLUMN prev_changed_date bigint;
CREATE INDEX CONCURRENTLY idx_usertokens_prev_refresh ON usertokens (prev_refresh_token) WHERE prev_refresh_token IS NOT NULL;
