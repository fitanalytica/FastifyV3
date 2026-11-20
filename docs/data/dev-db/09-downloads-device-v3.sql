-- downloads.deviceid: the install is created when the app is first opened (signed in or not), with its download id and its device id, and the place of its IP address
-- (docs/data/api.md section 1d). `usertokens.deviceid` is the same value, set at sign-in.
-- Run on the local database after 08-billing-standin.sql; the same statements are meant for production later:
--   psql -d fitanalytica_dev -f 09-downloads-device-v3.sql
-- Nullable and with no default: the old API (v2) inserts into `downloads` with its own column list and never reads this column, and rows made before it exist keep NULL.

ALTER TABLE downloads ADD COLUMN IF NOT EXISTS deviceid uuid;
COMMENT ON COLUMN downloads.deviceid IS 'the app''s own device id (the Keychain id): the same value as usertokens.deviceid once the install signs in; NULL for rows made before v3 or by v2';
CREATE INDEX IF NOT EXISTS idx_downloads_deviceid ON downloads (deviceid) WHERE deviceid IS NOT NULL;
