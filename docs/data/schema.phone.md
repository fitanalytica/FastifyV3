# Phone storage schema

Everything the React Native app keeps on the device: SQLite tables, MMKV keys and Keychain items. The rules that use them:
[phone.md](phone.md). The shape of an activity: [format.md](format.md).

**In the code, all of it lives in `src/data/`, one folder for each place the phone keeps things** (alias `@data`):

| Folder | Section | What it holds |
|---|---|---|
| `src/data/db/` | 1 | SQLite: the migrations (one file per version), the runner, the tables' SQL and types, `getDb()` |
| `src/data/mmkv/` | 2 | The MMKV instance and the zustand persistence (`index.ts`), the hand-written keys (`keys.ts`), the `KeyValue` adapter (`keyValue.ts`) |
| `src/data/keychain/` | 3 | The secret store (`index.ts`), the item names (`keys.ts`), the stable device and install ids (`ids.ts`) |
| `src/data/files/` | 4 | The photos kept for good, in the app's documents folder (`index.ts`: paths, download, remove) |

`src/data/api/` is the fourth folder: not storage but the HTTP client to the server ([phone.md](phone.md) section 0).
Nothing outside `src/data` imports `op-sqlite`, `react-native-mmkv`, `react-native-keychain`, `react-native-blob-util` or `axios` (one exception for SQLite: `src/services/activityStore.ts`, which reads the Swift recorder's own file, read-only).
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
  needs_conditions INTEGER NOT NULL DEFAULT 0, -- 1 = recorded here and still missing its place or weather: not sent yet (migration 008)
  activitydetail_v2 TEXT, activitylat TEXT, activitylon TEXT, activitytimenow TEXT,
  activityelevation TEXT, activitydistance TEXT, activitybpm_v2 TEXT,
  media_v2 TEXT,                            -- as the server has it; never a path on this phone (that is `media_files`)
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
| `activities_needs_conditions (startdate) WHERE needs_conditions = 1` | the pass that looks up the place and weather ([phone.md](phone.md) section 3b) |

```sql
CREATE INDEX activities_user_start ON activities (userid, startdate DESC);
CREATE INDEX activities_unsynced ON activities (startdate) WHERE synced = 0 AND sync_error IS NULL;
CREATE INDEX activities_delete_pending ON activities (activityid) WHERE delete_pending = 1;
CREATE INDEX activities_needs_conditions ON activities (startdate) WHERE needs_conditions = 1;
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

### `media_files`

Which photos of the user's activities are saved on this phone (migration `002_media_files`). It is a table of its own, not a field in `media_v2`, because `media_v2` is sent to the server as it is and a path on this phone must never travel.

```sql
CREATE TABLE media_files (
  activityid TEXT NOT NULL,
  value TEXT NOT NULL,                -- the file name, as in media_v2 (`<uuid>.webp`)
  state INTEGER NOT NULL DEFAULT 1,   -- 1 = the file is on the phone, 2 = the server has no such file (not asked for again)
  bytes INTEGER,
  hash TEXT,                          -- SHA-1 of the file (migration 004); empty for what was saved before it
  saved_at INTEGER NOT NULL,          -- epoch seconds
  PRIMARY KEY (activityid, value),
  CHECK (state IN (1, 2))
) WITHOUT ROWID;
```

The photos still to save are not a table: they are every photo item of the user's live activities (`json_each(media_v2)`) with no row here (`PENDING_SQL`). The path is never stored, only worked out (`<documents>/media/<activityid>/<value>`): the app's folder changes with each install on iOS.

### `media_uploads` and `media_deletes`

The media outbox (migration `003_media_uploads`): the work for the upload loop ([phone.md](phone.md), "Photos and videos you add"). Both are lists of work, so they work offline.

```sql
CREATE TABLE media_uploads (          -- a prepared photo or video that is not on the server yet
  id TEXT PRIMARY KEY,                 -- made on the phone
  activityid TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'photo' | 'video'
  file TEXT NOT NULL,                  -- a name in <documents>/media-pending/
  poster TEXT,                         -- a video's poster, also a name in media-pending/
  width INTEGER NOT NULL, height INTEGER NOT NULL,
  duration REAL,                       -- seconds, for a video
  bytes INTEGER NOT NULL, poster_bytes INTEGER,
  state INTEGER NOT NULL DEFAULT 0,    -- 0 = waiting, 1 = the server refused it (not tried again)
  created_at INTEGER NOT NULL,         -- upload order
  hash TEXT,                           -- SHA-1 of the prepared photo (migration 004); NULL for a video
  CHECK (kind IN ('photo', 'video')), CHECK (state IN (0, 1))
);
CREATE INDEX media_uploads_activity ON media_uploads (activityid, created_at);

CREATE TABLE media_deletes (          -- a file the user removed that the server still has
  activityid TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (activityid, value)
) WITHOUT ROWID;
```

**Duplicates (migration 004):** a photo's `hash` is the SHA-1 of its prepared WebP. Adding a photo whose hash is already among the activity's waiting files (`media_uploads`, state 0) or saved photos (`media_files`, state 1) is refused (`HAS_HASH_SQL`). The same picture prepared the same way gives the same bytes. A photo saved from the server gets its hash when it is downloaded; one saved before migration 004 has none, so only photos added or downloaded since are caught. Videos are not checked (a compression is not repeatable).

The next upload is the oldest waiting one of an activity with `synced = 1` and `delete_pending = 0` (`NEXT_UPLOAD_SQL`); without Wi-Fi a video is skipped. The next removal is the oldest of an activity with `synced = 1` and `delete_pending = 0`.

### `profile_image_ops`

What is waiting to go to the server for the profile picture and the cover (migration `005_profile_images`). One row per kind at most: a newer change replaces an older one that has not been sent.

```sql
CREATE TABLE profile_image_ops (
  kind TEXT PRIMARY KEY,               -- 'pic' (the profile picture) | 'bg' (the cover)
  op TEXT NOT NULL,                    -- 'set' (a prepared file is waiting) | 'reset' (go back to no image)
  file TEXT, bytes INTEGER,            -- for 'set': a name in <documents>/media-pending/, and its size
  created_at INTEGER NOT NULL,         -- milliseconds, so two changes never share it
  CHECK (kind IN ('pic', 'bg')), CHECK (op IN ('set', 'reset')),
  CHECK ((op = 'set' AND file IS NOT NULL AND bytes IS NOT NULL) OR op = 'reset')
) WITHOUT ROWID;
```

A change that was sent is forgotten with `DELETE … WHERE kind = ? AND created_at = ? AND op = ?` (`FINISH_OP_SQL`), so a change the user made while the old one was being sent is not lost. The names of the current picture and cover are in the profile (MMKV `profile`: `picture`, `cover`).

### `media_uploads.blur` (migration `006_media_blur`)

A nullable `TEXT` column: the 96-character colour grid of a waiting photo ([format.md](format.md) section 4), sent with its commit.

### `feed.db` (a separate file, a cache)

The feed is other people's data, so it is **not** in the main database and has **no migrations**: the file lives in the **Caches** folder, carries `PRAGMA user_version = 1`, and when that differs the file is dropped and made again (it is rebuilt from the server). Code: `src/data/db/feed.ts`.

```sql
CREATE TABLE feed_posts (            -- a normal rowid table: a reactive query only hears about those
  id INTEGER PRIMARY KEY,
  activityid TEXT NOT NULL UNIQUE,
  userid TEXT NOT NULL,
  enddate INTEGER NOT NULL,
  post TEXT NOT NULL,                -- the server's post as JSON, as sent
  fetched_at INTEGER NOT NULL
);
CREATE INDEX feed_posts_order ON feed_posts (enddate DESC, activityid DESC);
CREATE INDEX feed_posts_user  ON feed_posts (userid);
CREATE TABLE feed_activities (       -- whole activities opened from a card (the details screen)
  id INTEGER PRIMARY KEY, activityid TEXT NOT NULL UNIQUE, body TEXT NOT NULL, used_at INTEGER NOT NULL
);
CREATE TABLE feed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'next' (the cursor for the older page), 'etag', 'refreshed_at'
```

### `posts`

The user's own posts (migration `007_posts`): what they share from Home ([phone.md](phone.md) section 8d).

```sql
CREATE TABLE posts (
  postid TEXT PRIMARY KEY,
  posted_at INTEGER NOT NULL,              -- epoch seconds: the feed's order
  content TEXT NOT NULL,                   -- JSON, format.md section 7
  media_v2 TEXT NOT NULL DEFAULT '[]',     -- JSON: the server's list (never a path on the phone)
  media_count INTEGER NOT NULL DEFAULT 0,  -- how many files were added with it: sent with the first PUT, so a post with no words is allowed
  synced INTEGER NOT NULL DEFAULT 0,       -- 1 once the server has it
  delete_pending INTEGER NOT NULL DEFAULT 0, -- 1 = deleted here, the server not told yet
  created_at INTEGER NOT NULL,             -- milliseconds
  CHECK (synced IN (0, 1)), CHECK (delete_pending IN (0, 1))
);
```

The same shape as the server's row, so a post goes up and comes back without conversion. Its photos and videos wait in `media_uploads` under the post's id (the `activityid` column holds a post id too: the id is in one of the two tables), and the outbox sends a file only once the post is `synced = 1` and not deleted. `getMediaList` and `setMediaList` read and write the list of whichever table has the id. A post that was never sent is forgotten when deleted; one the server has stays with `delete_pending = 1` until the server is told.

**In `feed.db`** (the cache), a post of someone else is stored like an activity: `feed_posts.activityid` holds the id of the activity **or of the post** (random UUIDs never clash) and `enddate` its time; the JSON carries `kind`.

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
| `activity_start_conditions` | JSON | `{ at, lat, lon, weather?, place? }`: the place and weather found at the start of the activity being recorded; used once by that activity when it is saved (only if it is within an hour and 5 km of it), then removed |
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

The photos of the user's activities are kept **for good**, in the app's **documents** folder (`<documents>/media/<activityid>/<value>`), which the system does not clear and which is backed up with the phone. An image cache is not that: it can be emptied at any time (on iOS its default is 7 days), so it is only used for other people's photos in the feed.

- A photo is downloaded to `<value>.part` and moved into place when whole, so a file that is there is complete.
- A file the user added waits in `<documents>/media-pending/<name>` until the server has it, then moves into `media/<activityid>/<value>` (and gets a `media_files` row). A different account signing in removes `media-pending/` as well.
- Your profile picture and cover are kept as `<documents>/profile/<server file name>` (a new one has a new name, so the old copy is deleted). A different account signing in removes this folder too.
- It is deleted with the activity, and when an item is removed from the list. A different account signing in removes the whole `media` folder and every `media_files` row.
- At start the app checks that each file in `media_files` (state 1) is really there; one that is gone loses its row and is downloaded again.
