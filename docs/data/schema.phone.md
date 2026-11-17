# Phone storage schema

Everything the React Native app keeps on the device: SQLite tables, MMKV keys and Keychain items. The rules that use them:
[phone.md](phone.md). The shape of an activity: [format.md](format.md).

**In the code, all of it lives in `src/data/`, one folder for each place the phone keeps things** (alias `@data`):

| Folder | Section | What it holds |
|---|---|---|
| `src/data/db/` | 1 | SQLite: the migrations (one file per version), the runner, the tables' SQL and types, `getDb()` |
| `src/data/mmkv/` | 2 | The MMKV instance and the zustand persistence (`index.ts`), the hand-written keys (`keys.ts`), the `KeyValue` adapter (`keyValue.ts`) |
| `src/data/keychain/` | 3 | The secret store (`index.ts`), the item names (`keys.ts`), the stable device and install ids (`ids.ts`) |

`src/data/api/` is the fourth folder: not storage but the HTTP client to the server ([phone.md](phone.md) section 0).
Nothing outside `src/data` imports `op-sqlite`, `react-native-mmkv`, `react-native-keychain` or `axios` (one exception for SQLite: `src/services/activityStore.ts`, which reads the Swift recorder's own file, read-only).
`__tests__/dataLayer.test.ts` enforces it. When a key or an item is added, add it to `keys.ts` and to the tables below.

## 1. SQLite (op-sqlite)

**In the code: `src/data/db/`.**

| File | Holds |
|---|---|
| `migrations/001_activities.ts`, `002_…` | The schema, **one file per version**. A shipped migration is never edited: a change is the next number, listed last in `migrations/index.ts`. |
| `migrate.ts` | The runner: WAL, then each migration that has not run, in one transaction each, `PRAGMA user_version` moving on. |
| `activities.ts` | The `activities` table's stored type (`LocalActivity`), its columns, the insert, the list query and the clear. The SQL is plain strings. |
| `index.ts` | `getDb()`: opens `fitanalytica.db` and migrates it, once. Everything else imports from `@data/db`. |

`__tests__/db.test.ts` guards the migrations: the migration files are numbered without a gap and all listed, none sets the version or drops a column, and every stored column exists in the table.
The Swift recorder keeps its own database of raw fixes (`ios/ReactNative/ActivityStore.swift`); that one is separate and only read.

Opened with `PRAGMA journal_mode = WAL`. Migrations use `PRAGMA user_version`: each version is one migration script, run in order at start-up, inside a transaction.
A migration never drops or rewrites a column that can hold a row with `synced = 0` or `delete_pending = 1`.

### `activities`

The arrays are the decompressed (absolute) form as JSON text ([format.md](format.md) section 2).

```sql
CREATE TABLE activities (
  activityid TEXT PRIMARY KEY,
  userid TEXT NOT NULL,
  startdate INTEGER NOT NULL,
  enddate INTEGER NOT NULL,
  dtgraph INTEGER,                          -- the activity's local date as a date label: the day of an old-format row, which has no time zone of its own
  duration INTEGER, stepcount INTEGER, distance INTEGER,
  lat REAL, lon REAL,                       -- start point, degrees
  temp INTEGER, realfeel INTEGER, humidity INTEGER, wind REAL, uvi REAL,
  iso TEXT, weathericon TEXT, weather TEXT, city TEXT, state TEXT, aqi INTEGER,
  description TEXT,
  downloadid TEXT,                          -- the device that recorded it
  iswatch INTEGER NOT NULL DEFAULT 0,
  synced INTEGER NOT NULL DEFAULT 0,        -- 0 = not on the server, 1 = on the server
  sync_error TEXT,                          -- set when the server answered "invalid"
  delete_pending INTEGER NOT NULL DEFAULT 0, -- 1 = deleted by the user, waiting for the server
  activitydetail_v2 TEXT, activitylat TEXT, activitylon TEXT, activitytimenow TEXT,
  activityelevation TEXT, activitydistance TEXT, activitybpm_v2 TEXT,
  media_v2 TEXT,                            -- items also hold the local uri and posterUri (never sent)
  device TEXT, media_details TEXT,
  CHECK (synced IN (0, 1)),
  CHECK (iswatch IN (0, 1)),
  CHECK (delete_pending IN (0, 1))
);
```

### Indexes

| Index | For |
|---|---|
| `activities_user_start (userid, startdate DESC)` | lists, the calendar, feeds |
| `activities_unsynced (startdate) WHERE synced = 0 AND sync_error IS NULL` | step 2 of the sync loop |
| `activities_delete_pending (activityid) WHERE delete_pending = 1` | step 1 of the sync loop |

```sql
CREATE INDEX activities_user_start ON activities (userid, startdate DESC);
CREATE INDEX activities_unsynced ON activities (startdate) WHERE synced = 0 AND sync_error IS NULL;
CREATE INDEX activities_delete_pending ON activities (activityid) WHERE delete_pending = 1;
```

Lists and feeds select the summary columns only, and add `WHERE delete_pending = 0`. They never read the array columns.

### `steps_daily`

One row per day with data. The day is the date label of [format.md](format.md) section 5 (midnight UTC of the local date).

```sql
CREATE TABLE steps_daily (
  day INTEGER PRIMARY KEY,           -- a dtgraph: the local date as midnight UTC, a multiple of 86400 (README section 5)
  steps INTEGER NOT NULL DEFAULT 0,
  distance REAL NOT NULL DEFAULT 0,  -- metres
  ascend INTEGER NOT NULL DEFAULT 0, -- floors up
  descend INTEGER NOT NULL DEFAULT 0,
  iso TEXT,                          -- the country of that day, 2 letters
  synced INTEGER NOT NULL DEFAULT 0, -- 1 = the history arrays on the server include this day as it is now
  CHECK (synced IN (0, 1))
);
CREATE INDEX steps_daily_unsynced ON steps_daily (day) WHERE synced = 0;
```

Today's row is not part of the history until the day closes; its flag is `walk_today_synced` (section 2).

## 2. MMKV (encrypted, key in the Keychain)

| Key | Type | Meaning |
|---|---|---|
| `profile` | JSON | The user's profile ([phone.md](phone.md) section 9) |
| `profile_synced` | boolean | `false` when an edit has not been sent |
| `ipref` | string | The last `ipref` from the server, sent back as `X-Ipref`. Dropped when the user turns location off. |
| `restore_userid` | string | Whose restore the next four keys belong to. A different user signing in drops them and starts again. |
| `restore_cursor` | string | The next page of a restore (`<startdate>.<activityid>`). Removed when the restore is done. |
| `restore_done` | string | `'true'` once the restore has taken every page |
| `restore_total` | string | The user's activity count, from the first page (a progress bar) |
| `restore_loaded` | string | How many activities the restore has stored so far |
| `location_last` | JSON | `{ lat, lon, city, state, iso, sentAt }`: the last location sent |
| `location_fix_at` | number | When the last app-open fix was taken |
| `timezone_sent` | string | The last time zone sent |
| `walk_today_synced` | boolean | `false` when today's steps have changed and not been sent |
| `settings_media` | JSON | `photoMaxEdge`, `photoQuality`, `videoMaxSeconds`, `videoMaxEdge`, size caps (from the server, cached) |

## 3. Keychain

| Item | Holds |
|---|---|
| `refresh_token` | This device's refresh token |
| `mmkv_key` | The key that encrypts MMKV |
| `device_id` | Android only: the UUID created on the first launch, sent as `deviceid`. **Never wiped** (not at logout, not at account deletion). iOS uses `DeviceInfo.getUniqueId()` and stores nothing. (The first build of the app keeps a Keychain UUID on both platforms until `react-native-device-info` is added.) |

| `last_userid` | The `userid` of the last account that signed in. Kept at logout, compared at the next login (a different one wipes the local data, [phone.md](phone.md) section 10). Removed by Delete account. |

Logout removes only `refresh_token` (and the in-memory access token); `mmkv_key` and `device_id` stay, so the encrypted MMKV and the SQLite rows can be read again after the next sign-in.

The access token is kept in memory only. On the first launch after an install, clear any item left by a previous install (iOS keeps them).

## 4. Files

Prepared media (the compressed photo, video and poster) lives in the app's documents folder, referenced by the `uri` in each `media_v2` item.
It is deleted with the activity, and when an item is removed from the list.
