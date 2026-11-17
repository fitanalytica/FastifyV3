-- The tables as they are in production TODAY, rebuilt from the \d output you pasted. LOCAL DEVELOPMENT ONLY.
-- Not a dump: the other tables that point at
-- userlogin and downloads are left out. geometry(Point,4326) is the built-in point type here (see 02-postgis-standin.sql).
--   psql -d fitanalytica_dev -f 03-schema-current.sql

-- Enum values as in production (pasted from the owner's CREATE TYPE statements, 2026-11-15), except streak_status, which is still ASSUMED.
CREATE TYPE device_type_enum AS ENUM ('watch', 'chrome', 'phone', 'tablet', 'mac');
CREATE TYPE login_type_enum AS ENUM ('apple', 'google', 'qr');
CREATE TYPE platform_type_enum AS ENUM ('ios', 'android', 'ipados', 'watchos', 'windows', 'macos', 'wearos');
CREATE TYPE methods_enum AS ENUM ('GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE');
CREATE TYPE gender_enum AS ENUM ('male', 'female', 'other');
-- in production, used by tables this dev database does not have (kept so the list is complete):
CREATE TYPE email_type_enum AS ENUM ('welcome', 'birthday', 'newapp', 'account', 'subscription', 'weekly-report', 'monthly-report', 'inactive');
CREATE TYPE server_type_enum AS ENUM ('apple', 'google');
CREATE TYPE review_type_enum AS ENUM ('SHOW_SUBSCRIPTION', 'SHOW_REVIEW', 'SHOW_APP_OPEN_AD', 'NONE');
CREATE TYPE product_type_enum AS ENUM ('subscription', 'review');
CREATE TYPE offer_display AS ENUM ('offer', 'direct', 'review');
CREATE TYPE fcm_priority_enum AS ENUM ('high', 'medium', 'low');
-- ASSUMED (the real values were not sent):
CREATE TYPE streak_status AS ENUM ('in_progress', 'completed', 'failed');

CREATE TABLE userlogin (
  userid uuid PRIMARY KEY,
  stage smallint,
  loginused login_type_enum,
  email varchar(60),
  applegoogleid varchar(50) NOT NULL,
  CONSTRAINT idx_userlogin_applegoogleid UNIQUE (applegoogleid),
  CONSTRAINT userlogin_userid_applegoogleid_unique UNIQUE (userid, applegoogleid),
  CONSTRAINT applegoogleid_not_empty CHECK (applegoogleid::text <> ''::text),
  CONSTRAINT userlogin_stage_check CHECK (stage >= 0 AND stage <= 9)
);

CREATE TABLE downloads (
  downloadid uuid PRIMARY KEY,
  ddate integer DEFAULT EXTRACT(epoch FROM now()),
  stage smallint DEFAULT 0,
  is_watch_paired boolean DEFAULT false,
  device_type device_type_enum,
  platform platform_type_enum,
  iso char(2),
  device_os varchar(10),
  appversion varchar(10),
  device_code varchar(100),
  device_manufacturer varchar(100),
  device_model varchar(100),
  city varchar(50),
  state varchar(50),
  userid uuid,
  last_access_date integer DEFAULT EXTRACT(epoch FROM now()),
  total_session_count integer DEFAULT 0,
  total_session_duration integer DEFAULT 0,
  uninstall_date integer,
  fcm_token text,
  timezone text,
  CONSTRAINT downloads_stage_check CHECK (stage >= 0 AND stage <= 9)
);
CREATE INDEX idx_downloads_userid_ddate_desc ON downloads (userid, ddate DESC);
CREATE INDEX idx_downloads_userid_not_null ON downloads (userid) WHERE userid IS NOT NULL;
CREATE INDEX idx_downloads_active_tokens ON downloads (userid, fcm_token, timezone)
  WHERE fcm_token IS NOT NULL AND timezone IS NOT NULL AND userid IS NOT NULL;

CREATE TABLE userinfo (
  userid uuid PRIMARY KEY,
  store_id uuid,
  dateregistered integer NOT NULL,
  dobglobal integer,
  height real,
  weight real,
  seconds_from_gmt integer,
  hideprofile boolean DEFAULT false,
  gender gender_enum,
  iso varchar(2),
  mailids varchar(11),
  fname varchar(50),
  lname varchar(50),
  city varchar(50),
  state varchar(50),
  profilepic text,
  lat real,
  lon real,
  geom point NOT NULL,
  last_access_date integer DEFAULT EXTRACT(epoch FROM now()),
  about text,
  profilebg text,
  deleted_date integer,
  timezone text,
  CONSTRAINT userinfo_store_id_key UNIQUE (store_id)
);
CREATE INDEX idx_userinfo_dateregistered ON userinfo (dateregistered);
CREATE INDEX idx_userinfo_storeid_userid ON userinfo (userid) WHERE store_id IS NOT NULL;
CREATE INDEX idx_userinfo_visible_profiles ON userinfo (userid, seconds_from_gmt) WHERE hideprofile = false;
CREATE INDEX userinfo_geom_idx ON userinfo USING gist (geom);
CREATE INDEX userinfo_iso_idx ON userinfo (iso);

CREATE TABLE usertokens (
  deviceid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  userid uuid NOT NULL REFERENCES userlogin (userid) ON DELETE CASCADE,
  downloadid uuid NOT NULL,
  revoked boolean DEFAULT false,
  refresh_token char(64) NOT NULL,
  access_token char(64) NOT NULL,
  applegoogleid varchar(50) NOT NULL,
  device varchar(100) NOT NULL,
  changed_date bigint DEFAULT EXTRACT(epoch FROM now())::bigint,
  accessed_date bigint,
  apple_refresh_token varchar(255),
  CONSTRAINT usertokens_access_token_key UNIQUE (access_token),
  CONSTRAINT usertokens_refresh_token_key UNIQUE (refresh_token),
  CONSTRAINT unique_applegoogle_device UNIQUE (applegoogleid, device)
);
CREATE INDEX idx_usertokens_applegoogleid_device ON usertokens (applegoogleid, device);
CREATE INDEX idx_usertokens_userid ON usertokens (userid);

CREATE TABLE activities (
  activityid uuid PRIMARY KEY,
  userid uuid REFERENCES userlogin (userid) ON DELETE CASCADE,
  downloadid uuid REFERENCES downloads (downloadid),
  startdate integer,
  enddate integer,
  dtgraph integer,
  ddate integer DEFAULT EXTRACT(epoch FROM now()),
  lat real,
  lon real,
  temp smallint,
  realfeel smallint,
  humidity smallint,
  duration integer,
  stepcount integer,
  distance integer,
  wind real,
  uvi real,
  iso char(2),
  weathericon char(3),
  weather varchar(100),
  city varchar(50),
  state varchar(50),
  aqi smallint,
  tosend smallint DEFAULT 1,
  iswatch boolean DEFAULT false,
  geom point NOT NULL,
  activitydetail json,
  activitydistance json,
  activityelevation json,
  activitylat json,
  activitylon json,
  activitytimenow json,
  activitybpm json,
  device json,
  media jsonb,
  description varchar(200),
  media_details jsonb DEFAULT '[]'::jsonb
);
CREATE INDEX idx_activities_downloadid ON activities (downloadid);
CREATE INDEX idx_activities_tosend_enddate ON activities (tosend, enddate DESC);
CREATE INDEX idx_activities_userid ON activities (userid);
CREATE INDEX idx_activities_valid_media ON activities (activityid) WHERE media IS NOT NULL AND media <> 'null'::jsonb;

CREATE TABLE walkdata (
  userid uuid PRIMARY KEY REFERENCES userlogin (userid) ON DELETE CASCADE,
  max_steps_date integer,
  max_distance_date integer,
  max_steps integer,
  max_distance real,
  dtgraph integer,
  ascend smallint,
  descend smallint,
  stepcount integer,
  distance real,
  ddate integer DEFAULT EXTRACT(epoch FROM now()),
  dtgraph_json json,
  stepcount_json json,
  ascend_json json,
  descend_json json,
  distance_json json,
  iso_json json,
  steps_goal integer DEFAULT 10000
);
CREATE INDEX idx_walkdata_dtgraph_stepcount ON walkdata (dtgraph, stepcount DESC);
CREATE INDEX idx_walkdata_dtgraph_stepcount_filter ON walkdata (dtgraph, stepcount);
CREATE INDEX idx_walkdata_userid_dtgraph ON walkdata (userid, dtgraph);

CREATE TABLE streak_logs (
  streak_id uuid PRIMARY KEY,
  userid uuid NOT NULL REFERENCES userlogin (userid) ON DELETE CASCADE,
  level_id uuid NOT NULL,
  start_date bigint NOT NULL,
  end_date bigint,
  ddate bigint DEFAULT EXTRACT(epoch FROM now()),
  goal integer NOT NULL,
  duration integer DEFAULT 0,
  status streak_status NOT NULL,
  protection_used integer DEFAULT 0,
  daily_logs jsonb
);
CREATE INDEX idx_streak_logs_leaderboard ON streak_logs (userid, duration DESC) WHERE status = 'in_progress'::streak_status;

-- Application error log (production DDL as given by the owner). v3 writes here from the global error handler.
CREATE TABLE apperrors (
  errorid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ddate integer DEFAULT EXTRACT(EPOCH FROM now()),
  status_code smallint,
  method methods_enum,
  url text,
  ip text,
  error text,
  message text,
  code text,
  stack text,
  body json,
  userid uuid,
  query text,
  value json,
  tracking jsonb
);
