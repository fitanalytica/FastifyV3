# Postgres schema

The tables this spec touches, **as they should be after the changes**, with their constraints and indexes. Lines marked `-- NEW` or `-- CHANGED`
are what differs from today. The migration to get there is in section 8. The rules that use these columns: [server.md](server.md).

**Checked against your database (the `\d` output you pasted):** all columns, indexes and constraints of `activities`, `userinfo`, `downloads`, `userlogin` and `usertokens`.
**Not seen yet:** the other tables that point at `userlogin` and `downloads` (section 9). [schema-report.sql](schema-report.sql) prints more if needed.

## 1. `tosend`

Confirmed by you: `tosend` only ever holds `0`, `1` or `2`, and nothing else uses it. In this spec: `1` = the phone has it (the default), `2` = the watch uploaded it and the phone has not
acknowledged, `0` = deleted. The existing index `idx_activities_tosend_enddate (tosend, enddate DESC)` stays as it is.

## 2. `activities`

```sql
CREATE TABLE activities (
    activityid UUID PRIMARY KEY,
    userid UUID REFERENCES userlogin(userid) ON DELETE CASCADE,   -- confirmed (activities_userid_fkey)
    downloadid UUID REFERENCES downloads(downloadid),     -- confirmed (activities_downloadid_fkey, no action); the device that recorded it
    startdate INTEGER,                                    -- epoch seconds, UTC
    enddate INTEGER,
    dtgraph INTEGER,                                      -- a date label (README section 5); assumed the activity's local day
    ddate INTEGER DEFAULT (EXTRACT(EPOCH FROM now())),
    lat REAL,                                             -- start point, approximate: search and display only; the exact start is read from geom
    lon REAL,
    temp SMALLINT,
    realfeel SMALLINT,
    humidity SMALLINT,
    duration INTEGER,                                     -- seconds
    stepcount INTEGER,
    distance INTEGER,                                     -- metres
    wind REAL,
    uvi REAL,
    iso CHAR(2),
    weathericon CHAR(3),
    weather VARCHAR(100),
    city VARCHAR(50),
    state VARCHAR(50),
    aqi SMALLINT,
    tosend SMALLINT DEFAULT 1,                            -- 0 deleted, 1 phone has it, 2 watch uploaded and phone has not acked (section 1)
    iswatch BOOLEAN DEFAULT false,                        -- never updated on a repeat
    geom GEOMETRY(Point, 4326) NOT NULL,                  -- built by the server from lat and lon
    activitydetail JSON,                                  -- old format: 1 to 5 per point
    activitydistance JSON,                                -- the actual values in metres, as today
    activityelevation JSON,                               -- the actual values in metres, as today
    activitylat JSON,                                     -- already increments in 1e-5 degrees: [0, 10, ...] (confirmed)
    activitylon JSON,                                     -- already increments in 1e-5 degrees (confirmed)
    activitytimenow JSON,                                 -- already increments in seconds from startdate (confirmed)
    activitybpm JSON,                                     -- old format: actual values, one per location update
    device JSON,
    media JSONB,                                          -- old format: webp names
    description VARCHAR(200),                             -- editable on a repeat
    media_details JSONB DEFAULT '[]'::jsonb,              -- old format
    activitydetail_v2 JSON,                               -- NEW: { enc, tz, breaks }
    activitybpm_v2 JSON,                                  -- NEW: { t: [...], v: [...] }
    media_v2 JSONB DEFAULT '[]'::jsonb,                   -- NEW: [ { type, value, dimension, ... } ], editable on a repeat. JSONB, like `media`
    CONSTRAINT activities_tosend_ck CHECK (tosend IN (0, 1, 2))   -- NEW (proposed)
);
```

The track columns `activitylat`, `activitylon` and `activitytimenow` **already hold increments** in old rows (`[0, 10, ...]`, and seconds from `startdate`), the same form as
the new format ([format.md](format.md) section 2), so they are read the same way for old and new rows; the increments are in 5 decimals (1e-5 degrees). `activityelevation`, `activitydistance` and `activitybpm` hold actual values.
What differs in old rows is `activitydetail`, `activitybpm` and `media`; a row is in the new format when **`activitydetail_v2` is not empty**. Still to confirm: the units of the old elevation and distance (README open item 14).

### Indexes

| Index | For | State |
|---|---|---|
| `activities_pkey (activityid)` | the upsert, delete, presign, commit | existing |
| `idx_activities_userid (userid)` | | existing |
| `idx_activities_downloadid (downloadid)` | the foreign key | existing |
| `idx_activities_tosend_enddate (tosend, enddate DESC)` | see section 1 | existing |
| `idx_activities_valid_media (activityid) WHERE media IS NOT NULL AND media <> 'null'` | old media | existing |
| `activities_user_start (userid, startdate DESC, activityid DESC) WHERE tosend > 0` | restore pages | NEW |
| `activities_user_watch_start (userid, startdate DESC) WHERE iswatch AND tosend > 0` | the watch's 50 | NEW |
| `activities_inbox (userid) WHERE tosend = 2` | the phone's inbox (stays tiny) | NEW |

```sql
CREATE INDEX activities_user_start       ON activities (userid, startdate DESC, activityid DESC) WHERE tosend > 0;
CREATE INDEX activities_user_watch_start ON activities (userid, startdate DESC) WHERE iswatch AND tosend > 0;
CREATE INDEX activities_inbox            ON activities (userid) WHERE tosend = 2;
```

`activities_user_start` serves the same lookups as `idx_activities_userid` plus the order; once the new one is in use, check whether the old one can go.
There is no index on `activities.geom`; add one only if you start querying by place.

### Constraints and notes

- `downloadid` references `downloads` with no action. A `downloads` row cannot be deleted while activities (or `app_sync`, `app_sync_sandbox`, `user_topics`) point to it.
  Unpairing therefore only revokes and clears flags ([api.md](api.md) section 1), and account deletion deletes the referencing rows first ([server.md](server.md) section 8).
- `userid` references `userlogin` with `ON DELETE CASCADE` (confirmed): deleting the login deletes the activities. There are no check constraints today.
- `tosend` is stored with the `CHECK` above. The server also never lets it go up: the upsert keeps the lower value ([server.md](server.md) section 2).

## 3. `userinfo`

```sql
CREATE TABLE userinfo (
    userid UUID PRIMARY KEY,                -- no foreign key to userlogin: deleting a login does not delete this row
    store_id UUID UNIQUE,
    dateregistered INTEGER NOT NULL,
    dobglobal INTEGER,
    height REAL,
    weight REAL,
    seconds_from_gmt INTEGER,               -- optional; goes stale at daylight-saving changes
    hideprofile BOOLEAN DEFAULT FALSE,
    gender gender_enum,
    iso VARCHAR(2),
    mailids VARCHAR(11),
    fname VARCHAR(50),
    lname VARCHAR(50),
    city VARCHAR(50),
    state VARCHAR(50),
    profilepic TEXT,                        -- a file name in bucket fitpy, or an https address from a sign-in provider
    lat REAL,                               -- approximate; the exact coordinates are in geom
    geom GEOMETRY(Point, 4326) NOT NULL,    -- CHANGED: becomes nullable, an unknown location is NULL, never 0,0
    geo_source SMALLINT,                    -- NEW: 1 = ip, 2 = gps
    last_access_date INTEGER DEFAULT (EXTRACT(EPOCH FROM now())),
    about TEXT,
    profilebg TEXT,
    deleted_date INTEGER,                   -- when the user deleted the account
    timezone TEXT,                          -- nullable today (your DDL said NOT NULL)
    CONSTRAINT userinfo_geo_source_ck CHECK (geo_source IN (1, 2))   -- NEW (proposed; NULL passes)
);
```

Existing indexes (all kept): `userinfo_pkey (userid)`, `userinfo_store_id_key` unique `(store_id)`, `idx_userinfo_dateregistered (dateregistered)`,
`idx_userinfo_storeid_userid (userid) WHERE store_id IS NOT NULL`, `idx_userinfo_visible_profiles (userid, seconds_from_gmt) WHERE hideprofile = false`,
`userinfo_geom_idx` GiST `(geom)`, `userinfo_iso_idx (iso)`.

There are no foreign keys and no check constraints today. Because there is no foreign key to `userlogin`, **deleting an account must delete this row
explicitly** ([server.md](server.md) section 8). The GiST index on `geom` allows NULLs, so making `geom` nullable needs nothing else. `lat` and `lon` stay `REAL`; the exact
coordinates are in `geom`, which stores doubles.

## 4. `downloads` (the device list)

```sql
CREATE TABLE downloads (
    downloadid UUID PRIMARY KEY,
    ddate INTEGER DEFAULT (EXTRACT(EPOCH FROM now())),
    stage SMALLINT DEFAULT 0,
    is_watch_paired BOOLEAN DEFAULT FALSE,
    device_type device_type_enum,           -- the watch is 'watch' (it already exists)
    platform platform_type_enum,
    iso CHAR(2),
    device_os VARCHAR(10),
    appversion VARCHAR(10),
    device_code VARCHAR(100),
    device_manufacturer VARCHAR(100),
    device_model VARCHAR(100),
    city VARCHAR(50),                       -- from the first-download IP lookup
    state VARCHAR(50),
    userid UUID,                            -- no foreign key; empty until the user signs in
    last_access_date INTEGER DEFAULT (EXTRACT(EPOCH FROM now())),
    total_session_count INTEGER DEFAULT 0,
    total_session_duration INTEGER DEFAULT 0,
    uninstall_date INTEGER,
    fcm_token TEXT,
    timezone TEXT,
    CONSTRAINT downloads_stage_check CHECK (stage >= 0 AND stage <= 9)
);
```

No change to the columns. Existing indexes: `downloads_pkey`, `idx_downloads_userid_ddate_desc (userid, ddate DESC)`,
`idx_downloads_userid_not_null (userid) WHERE userid IS NOT NULL`, `idx_downloads_active_tokens (userid, fcm_token, timezone) WHERE ...not null`.
Each install, phone or watch, has its own row.

**Tables that reference `downloads`** (none with a delete action): `activities`, `app_sync`, `app_sync_sandbox`, `user_topics`. Rows are deleted by account deletion,
after the rows that point to them (section 9). I have not seen the last three tables (README open item 17).

## 5. `userlogin`

```sql
CREATE TABLE userlogin (
    userid UUID PRIMARY KEY,
    stage SMALLINT,
    loginused login_type_enum,
    email VARCHAR(60),
    applegoogleid VARCHAR(50) NOT NULL,
    CONSTRAINT idx_userlogin_applegoogleid UNIQUE (applegoogleid),
    CONSTRAINT userlogin_userid_applegoogleid_unique UNIQUE (userid, applegoogleid),
    CONSTRAINT applegoogleid_not_empty CHECK (applegoogleid::text <> ''::text),
    CONSTRAINT userlogin_stage_check CHECK (stage >= 0 AND stage <= 9)
);
```

No change. Many tables point at it (section 9), almost all with `ON DELETE CASCADE`.

## 6. `usertokens`

```sql
CREATE TABLE usertokens (
    deviceid UUID PRIMARY KEY,                   -- CHANGED: set by the app to DeviceInfo.getUniqueId() (today the database generates it)
    userid UUID NOT NULL REFERENCES userlogin(userid) ON DELETE CASCADE,   -- usertokens_userid_fkey
    downloadid UUID NOT NULL,                    -- the install's downloads row (a random UUID per download); no foreign key
    revoked BOOLEAN DEFAULT FALSE,
    refresh_token CHAR(64) NOT NULL,             -- SHA-256 hash, unique
    access_token CHAR(64) NOT NULL,              -- SHA-256 hash, unique
    applegoogleid VARCHAR(50) NOT NULL,
    device VARCHAR(100) NOT NULL,                -- the hardware model; information only
    changed_date BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::bigint),
    accessed_date BIGINT,
    apple_refresh_token VARCHAR(255),            -- needed to revoke Sign in with Apple on account deletion
    prev_refresh_token CHAR(64),                 -- NEW: the refresh value before the last rotation, accepted for 2 minutes
    prev_changed_date BIGINT,                    -- NEW: when that rotation happened
    CONSTRAINT usertokens_access_token_key UNIQUE (access_token),
    CONSTRAINT usertokens_refresh_token_key UNIQUE (refresh_token)
    -- REMOVED: CONSTRAINT unique_applegoogle_device UNIQUE (applegoogleid, device)
);
```

Indexes: `usertokens_pkey (deviceid)`, the two unique constraints above, `idx_usertokens_userid (userid)`, and NEW `idx_usertokens_prev_refresh (prev_refresh_token) WHERE prev_refresh_token IS NOT NULL`.
Removed: the constraint `unique_applegoogle_device (applegoogleid, device)` and its duplicate index `idx_usertokens_applegoogleid_device`.

**One row per physical device.**
- The login supplies `deviceid`, the app's `DeviceInfo.getUniqueId()`. On iOS that is a UUID, different for every phone and kept across an uninstall. So two iPhones of the same model on one account now get
  two rows (that is why the old unique key on the model had to go), and a reinstall of the same phone replaces its own row.
- The login upserts on `deviceid` and updates **everything** on a conflict: `userid`, `applegoogleid`, `downloadid`, `device`, both tokens, `apple_refresh_token`, `revoked = false`, `prev_refresh_token = NULL`.
  Another account signing in on the same phone therefore takes over that phone's row.
- **Android sends a UUID the app creates** on its first launch and keeps ([phone.md](phone.md) section 1). It is not `getUniqueId()` (on Android that is not a UUID). A reinstall makes a new row, and the 365 day clean-up removes the old one. So two phones of the same model
  on one account no longer collide on Android either.
- **No `deviceid` in the request** (older app versions only): find the row by `(applegoogleid, device)` and update it, or else insert one with a generated `deviceid`. This is the old behaviour.
- `downloadid` is a random UUID for each download of the app (it counts downloads). A reinstall gives a new `downloadid` and, on iOS, the same `deviceid`.

**Tokens**
- `access_token` and `refresh_token` hold a SHA-256 hash (64 hex characters, which is why the columns are `CHAR(64)`). Older rows still hold the raw value, and the lookup accepts both. The bearer token the app sends is a
  JWT whose payload carries the raw `access_token` ([api.md](api.md) section 1). The device kind (phone or watch) comes from the `downloads` row (`downloads.device_type`), because `usertokens.device` is a hardware model.
- **A refresh keeps the previous value for 2 minutes** (`prev_refresh_token`), so a lost reply does not sign the user out ([server.md](server.md) section 10).
- **Old rows.** An upgrade to a new phone leaves the old phone's row, with live tokens, until the clean-up deletes it: rows not used for **365 days** ([server.md](server.md) section 9).
- Migrate the old raw rows to hashes when it suits you, and then the lookup can drop the raw comparison.

## 7. Enums

The enums exist today and **none needs a change**. The values, as in production (from the owner's `CREATE TYPE` statements):

| Enum | Values | Used by |
|---|---|---|
| `device_type_enum` | `watch`, `chrome`, `phone`, `tablet`, `mac` | `downloads.device_type` |
| `platform_type_enum` | `ios`, `android`, `ipados`, `watchos`, `windows`, `macos`, `wearos` | `downloads.platform` |
| `login_type_enum` | `apple`, `google`, `qr` | `userlogin.loginused` |
| `methods_enum` | `GET`, `PUT`, `POST`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`, `TRACE` | `apperrors.method` |
| `gender_enum` | `male`, `female`, `other` | `userinfo` |
| `email_type_enum`, `server_type_enum`, `review_type_enum`, `product_type_enum`, `offer_display`, `fcm_priority_enum` | see `dev-db/03-schema-current.sql` | tables outside this spec |

The watch already has its value: `device_type = 'watch'`, and its `platform` is `watchos` (or `wearos`). v3 supports the phone and the watch only: `phone` and `tablet` are the phone side, `watch` is the watch side, and `chrome`, `mac` and a missing type are refused (README open item 30).

### `apperrors` (the error log)

v3's global error handler writes one row per error it answers, with these exceptions: the routine codes the app handles by itself (`TOKEN_EXPIRED`, `LOGOUT`, `NOT_FOUND`) are not logged. The reply carries the new `errorid` (empty if the insert failed; a failed insert never changes the reply). Token values in the request body are stored as `[redacted]`, and an array body (a batch of activities) is not stored.

```sql
CREATE TABLE apperrors (
    errorid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ddate INTEGER DEFAULT EXTRACT(EPOCH FROM now()),
    status_code SMALLINT,
    method methods_enum,
    url TEXT, ip TEXT, error TEXT, message TEXT, code TEXT, stack TEXT,
    body JSON, userid UUID, query TEXT, value JSON,
    tracking JSONB                       -- set from the admin portal (status such as solved, observing) to follow up an issue; the API never writes it
);
```

No index and no foreign key (an error row must always be insertable, even for an unknown user). A log that is only ever appended to; a purge of rows older than 30 days belongs to the housekeeping list.

## 8. Migration (from today to this)

Run in this order.

```sql
-- 1. activities: the new columns, and tosend with its three values
ALTER TABLE activities
  ADD COLUMN activitydetail_v2 JSON,
  ADD COLUMN activitybpm_v2    JSON,
  ADD COLUMN media_v2          JSONB DEFAULT '[]'::jsonb;
COMMENT ON COLUMN activities.tosend IS '1 phone has it, 2 watch uploaded and phone has not acked, 0 deleted';
ALTER TABLE activities ADD CONSTRAINT activities_tosend_ck CHECK (tosend IN (0, 1, 2)) NOT VALID;
ALTER TABLE activities VALIDATE CONSTRAINT activities_tosend_ck;

-- 2. activities: indexes (CONCURRENTLY, outside a transaction)
CREATE INDEX CONCURRENTLY activities_user_start       ON activities (userid, startdate DESC, activityid DESC) WHERE tosend > 0;
CREATE INDEX CONCURRENTLY activities_user_watch_start ON activities (userid, startdate DESC) WHERE iswatch AND tosend > 0;
CREATE INDEX CONCURRENTLY activities_inbox            ON activities (userid) WHERE tosend = 2;

-- 3. userinfo: location
ALTER TABLE userinfo ADD COLUMN geo_source SMALLINT;
ALTER TABLE userinfo ALTER COLUMN geom DROP NOT NULL;
ALTER TABLE userinfo ADD CONSTRAINT userinfo_geo_source_ck CHECK (geo_source IN (1, 2));

-- 4. walkdata: the base the history arrays were encoded against
ALTER TABLE walkdata ADD COLUMN history_base INTEGER;
-- the previous day, for yesterday's leaderboard (section 10, `walkdata`)
ALTER TABLE walkdata ADD COLUMN yesterday_dtgraph INTEGER, ADD COLUMN yesterday_stepcount INTEGER, ADD COLUMN yesterday_distance REAL;
CREATE INDEX CONCURRENTLY idx_walkdata_yesterday_stepcount ON walkdata (yesterday_dtgraph, yesterday_stepcount DESC) WHERE yesterday_dtgraph IS NOT NULL;

-- 5. usertokens: one row per device, and the refresh grace
ALTER TABLE usertokens DROP CONSTRAINT unique_applegoogle_device;                -- also drops the index behind it
DROP INDEX CONCURRENTLY IF EXISTS idx_usertokens_applegoogleid_device;           -- the duplicate
ALTER TABLE usertokens ADD COLUMN prev_refresh_token CHAR(64), ADD COLUMN prev_changed_date BIGINT;
CREATE INDEX CONCURRENTLY idx_usertokens_prev_refresh ON usertokens (prev_refresh_token) WHERE prev_refresh_token IS NOT NULL;

-- 6. duplicate indexes (measured: 0 scans; the kept index is the one in use)
DROP INDEX CONCURRENTLY IF EXISTS idx_walkdata_dtgraph_stepcount;          -- keep idx_walkdata_dtgraph_stepcount_filter
DROP INDEX CONCURRENTLY IF EXISTS idx_user_topics_unsubscribed_downloadid; -- keep idx_user_topics_downloadid_false
-- other zero-scan candidates: see performance.md section 10 (check the statistics window first)

-- 7. the testing tables (first turn off the server code that writes them, and keep a copy: pg_dump -t app_sync -t sync_body -t user_sessions ...)
DROP TABLE app_sync, sync_body, user_sessions;
```

Existing rows: most have `tosend = 1` (the default), so they read as "the phone has it". **Not all do:** see "What the real data shows" below, and run its two checks on production before the migration.
Existing `userinfo` locations have no `geo_source`; treat `NULL` as IP. No table is rewritten: `lat` and `lon` keep their type, and the exact start point is read from `geom`.

### What the real data shows

Two real accounts were exported from production as CSV and imported into the local database (85 and 2,010 activities; `dev-db/import-activities-csv.py`). What they contain, and what it means for v3:

| Finding | In the data | What v3 does / what to do |
|---|---|---|
| **Every row is old-format** | `activitydetail_v2` is empty on all 2,095 rows | Restore sends the old columns as they are and the app converts ([format.md](format.md) section 3). |
| **`geom` is wrong on some old rows** | 12 of 85 rows have `geom` = (`lat`, `lon`) swapped; 1 row is (0, 0) with a 1970 start time. The other account is clean (max difference 0.000002 degrees). Several v2 code paths build it with the arguments in the wrong order | The read side never uses `geom` for an old row (`lat`/`lon` columns instead). Optional one-off repair if anything else reads `geom` of old rows, for example a location search: `UPDATE activities SET geom = ST_SetSRID(ST_MakePoint(lon::float8, lat::float8), 4326) WHERE activitydetail_v2 IS NULL AND lat IS NOT NULL AND lon IS NOT NULL` (check that `lat` and `lon` are right first). |
| **`tosend = 0` rows exist** | 3 of 85 rows, each with a full track. They are not deleted markers. v2 never deletes with 0: its delete is a hard `DELETE`, and the old app writes its own `tosend` | v2's reads already skip them (`tosend > 0`), and v3 treats 0 as "never returned", so nothing changes for them. They keep their data. |
| **`tosend = 2` may exist** | None in these two accounts, but v2's watch sync writes `tosend: 2` (`wearable/v2/sync.ts`) | In v3, 2 means "waiting in the phone's inbox". Old watch rows left at 2 would all appear in the first inbox of every phone. **Before the migration run the count below, and if there are many, `UPDATE activities SET tosend = 1 WHERE tosend = 2` once.** |
| **`iswatch` is NULL on old rows** | 1 of 85 and 350 of 2,010 | Treat NULL as false. `activities_user_watch_start` (`WHERE iswatch AND tosend > 0`) already leaves them out. |
| **`device` is a broken JSON array on some rows** | `["{\"isWatchPaired\":true","\"manufacturer\":\"apple\"", ...]` (a v2 bug: the object was split at the commas). Valid JSON, wrong shape | Stored and returned as it is; the app ignores `device` on old rows. |
| **`userinfo.geom` is not swapped, but not always exact** | 2 real accounts (`dev-db/import-userinfo-csv.py`): `geom` agrees with `lat`/`lon` to 0.0001 degrees for one and to 0.045 degrees (about 5 km) for the other; `geo_source` does not exist yet (NULL, read as IP); `deleted_date` is NULL on both | v3 builds `geom` from the request's `lat` and `lon` when the location is sent ([server.md](server.md) section 7), so a row is brought in line by its next location update. Nothing reads it in the meantime. |
| **`temp` and `realfeel` are in kelvin** | 265 to 308 in 2,092 real rows (-8 to 35 °C); `weathericon` is an OpenWeather code (`02d`, `10n`, …); `weather` is the provider's free text (`Partly cloudy`, `broken clouds`, `Patchy rain possible`: more than one provider); `humidity` is 26 to 100; `uvi` 0 to 10.7; `aqi` 1 to 5; `wind` 0 to 52.6, read as km/h (not confirmed) | The phone converts: a value over 150 is kelvin, under it °C (`features/weather/icon.ts`). Say so if a provider's wind is in m/s. |
| **`activitydistance` is the step between points** | in the old rows (see [format.md](format.md) section 2) | The phone works the distance out from the coordinates and ignores this array. |
| **Steps and distance agree** | 1.46 steps per metre (a 0.68 m stride), median of 600 activities over 2 km | The Steps card uses `stepcount` as it is. |
| **The track times cover most of the duration** | the last point is at about 91 to 94 percent of the `duration` column | Pace is worked out from the track's own times, so it always agrees with the distance along the route. |
| **Activities are small** | 2,010 activities restore in full as 3.75 MB (about 2 KB each) | See [api.md](api.md) section 4. |

Checks to run on production before the migration (they read counts only; `schema-report.sql` section 11 has the first):
```sql
SELECT tosend, iswatch, count(*) FROM activities GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) FROM activities WHERE activitydetail_v2 IS NULL AND (geom::geometry <-> ST_SetSRID(ST_MakePoint(lon::float8, lat::float8), 4326)) > 0.001;  -- rows whose geom disagrees with lat/lon
```

Not a migration: a daily job that deletes old token rows ([server.md](server.md) section 9).

## 9. Other tables that point at `userlogin` and `downloads`

From the `Referenced by` lists. I have not seen any of these tables.

| Table | Points at | On delete |
|---|---|---|
| `activities`, `app_actions`, `app_sync`, `app_sync_sandbox`, `offers_displayed`, `paymenterrors`, `paymenterrors_sandbox`, `protection_logs`, `reviews`, `streak_logs`, `sync_body`, `user_responses`, `user_sessions`, `user_topics`, `usertokens`, `walkdata`, `weightmanagement` | `userlogin` | `CASCADE` |
| `validatereceipts_sandbox` | `userlogin` | `SET NULL` |
| `quotations` | `userlogin` | **no action: blocks deleting a login** |
| `activities`, `app_sync`, `app_sync_sandbox`, `user_topics` | `downloads` | no action |

`app_sync`, `sync_body` and `user_sessions` are testing tables and optional (confirmed by you): they are not part of this design and are to be dropped (section 8, step 6); `app_sync` pointing at `downloads` goes with them.

(The list you pasted stopped after `weightmanagement`, so there may be more.) What this means for deleting an account:
`DELETE FROM userlogin` removes almost everything by cascade, including the activities, and removes the rows that point at `downloads`. It fails while the user has rows in `quotations`, so
those are deleted first (or the key is changed to cascade). `downloads` and `userinfo` have no foreign key to `userlogin` and are deleted by hand, **after** the cascade
has removed the rows that point at them ([server.md](server.md) section 8).

## 10. Tables seen, not yet specified

Pasted from `\d`; to be gone through one at a time. What each might become under the ground rules is in the README open items.

### `walkdata` (one row per user)

```sql
CREATE TABLE walkdata (
    userid UUID PRIMARY KEY REFERENCES userlogin(userid) ON DELETE CASCADE,
    max_steps_date INTEGER, max_distance_date INTEGER,
    max_steps INTEGER, max_distance REAL,
    dtgraph INTEGER,                         -- a date label, see README section 5
    ascend SMALLINT, descend SMALLINT,       -- floors
    stepcount INTEGER, distance REAL,
    ddate INTEGER DEFAULT (EXTRACT(EPOCH FROM now())),
    dtgraph_json JSON, stepcount_json JSON, ascend_json JSON, descend_json JSON, distance_json JSON, iso_json JSON,
    steps_goal INTEGER DEFAULT 10000,
    history_base INTEGER,                    -- NEW: the day the arrays' deltas were encoded against; set means the arrays hold completed days only
    yesterday_dtgraph INTEGER,               -- NEW: the day before `dtgraph` (always dtgraph - 86400), sent by the phone; NULL until it has sent one
    yesterday_stepcount INTEGER,             -- NEW: that day's final steps, for yesterday's leaderboard
    yesterday_distance REAL                  -- NEW: that day's metres (stored, not ranked on)
);
-- indexes: walkdata_pkey (userid); idx_walkdata_dtgraph_stepcount (dtgraph, stepcount DESC);
--          idx_walkdata_dtgraph_stepcount_filter (dtgraph, stepcount); idx_walkdata_userid_dtgraph (userid, dtgraph)
--          NEW idx_walkdata_yesterday_stepcount (yesterday_dtgraph, yesterday_stepcount DESC) WHERE yesterday_dtgraph IS NOT NULL
```

What it holds (confirmed from a sample row and your code):
- **`yesterday_*` are the previous day, kept so yesterday's leaderboard can be read from the database.** When a user syncs the next day, `dtgraph` and `stepcount` move on, and the finished day would survive only inside the compact arrays, which cannot be ranked without decoding every user.
  The phone sends them with each `PUT /walk/today` and the server stores them as received ([server.md](server.md) section 11). A board for a day `L` reads both places: users whose `dtgraph = L` and users whose `yesterday_dtgraph = L`. A user is in at most one of them.
- **`dtgraph` is a calendar date, not an instant** ([README](README.md) section 5): that date at midnight UTC, a multiple of 86400, the same label for every time zone.
  `stepcount`, `distance` (metres), `ascend` and `descend` (floors up and down) are that day's totals, "today". `ddate` is when the row was last written.
- `max_steps` and `max_distance`, with `max_steps_date` and `max_distance_date` (date labels), are the personal records.
- **The `*_json` columns have one entry per day with data, oldest to newest:** `stepcount_json`, `distance_json` (metres), `ascend_json`, `descend_json`. Their last entry equals today's value.
- **`dtgraph_json` holds the dates as day deltas against today's `dtgraph`** (`encodeDeltas` / `decodeDeltas`): element `i` is the number of days from day `i` to day `i + 1`, and the last element is the number of days from the last entry to
  today's `dtgraph`. So it ends in `0` when the last entry is today, and a number above 1 is a gap (a run of days with no data). The first entry's date is not stored; decoding walks back from today.
- **`iso_json` is run-length encoded, one country per day** (`rleEncode` / `rleDecode`): `[["IN",328],["TR",15],["IN",53]]` means 328 days in India, then 15 in Turkey, then 53 in India. Decoded, it lines up with the other arrays, and
  **the world map is the sum of the steps per country** after decoding.
- The indexes on `(dtgraph, stepcount DESC)` rank users by steps for one date: the challengers. They use only today's columns, not the arrays.

### `streak_logs` (one row per streak)

```sql
CREATE TABLE streak_logs (
    streak_id UUID PRIMARY KEY,
    userid UUID NOT NULL REFERENCES userlogin(userid) ON DELETE CASCADE,
    level_id UUID NOT NULL,
    start_date BIGINT NOT NULL, end_date BIGINT,
    ddate BIGINT DEFAULT (EXTRACT(EPOCH FROM now())),
    goal INTEGER NOT NULL, duration INTEGER DEFAULT 0,
    status streak_status NOT NULL,
    protection_used INTEGER DEFAULT 0,
    daily_logs JSONB
);
-- indexes: streak_logs_pkey (streak_id); idx_streak_logs_leaderboard (userid, duration DESC) WHERE status = 'in_progress'
-- referenced by: protection_logs.streak_id (ON DELETE CASCADE)
```

What it holds (my reading of a sample row, to confirm): `goal` is the daily steps needed (10000), `duration` the days, `status` the `streak_status` (for example `in_progress`, `failed`), `protection_used` how many protection days
were spent, `start_date` and `end_date` epoch seconds. `daily_logs` is a list with one item per level, `{ level_id, logs: [ { s: steps that day, p: true on a protection day } ] }`. The leaderboard index ranks current streaks by `duration`.

### `app_sync` (a log of syncs; testing only, optional, to be dropped)

```sql
CREATE TABLE app_sync (
    syncid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    downloadid UUID REFERENCES downloads(downloadid),
    userid UUID NOT NULL REFERENCES userlogin(userid) ON DELETE CASCADE,
    ddate INTEGER DEFAULT (EXTRACT(EPOCH FROM now())),
    bgsync BOOLEAN DEFAULT false
);
-- indexes: app_sync_pkey (syncid); idx_app_sync_ddate (ddate); idx_app_sync_userid (userid)
```

What it holds: one row each time a sync runs, with the device (`downloadid`), the user, the time, and whether it was a background sync (`bgsync`). It stores no data.

### `sync_body` (one JSON document per user; testing only, optional, to be dropped)

```sql
CREATE TABLE sync_body (
    userid UUID PRIMARY KEY REFERENCES userlogin(userid) ON DELETE CASCADE,
    body JSON,
    ddate INTEGER DEFAULT (EXTRACT(EPOCH FROM now()))
);
```

What it holds: the whole payload of the last sync, per user (overwritten each time). The same data is also split into the other tables, so it is stored twice.

