# Watch storage schema

Everything the watch app keeps on the device. The rules that use it: [watch.md](watch.md). The shape of an activity: [format.md](format.md).
The phone's version of this table: [schema.phone.md](schema.phone.md).

## 1. SQLite

Opened with `PRAGMA journal_mode = WAL`; migrations use `PRAGMA user_version`, as on the phone.
The watch only stores activities **recorded on the watch** (`iswatch = 1`), and the newest 50 of them.

### `activities`

Same columns as the phone's table, with two flags in place of `synced`, no `media_v2` (the watch uploads no media), and `phone_sent_at` (below). Built: `ios/WatchApp/WatchActivityStore.swift`.

```sql
CREATE TABLE activities (
  activityid TEXT PRIMARY KEY,
  userid TEXT NOT NULL,
  startdate INTEGER NOT NULL,
  enddate INTEGER NOT NULL,
  duration INTEGER, stepcount INTEGER, distance INTEGER,
  lat REAL, lon REAL,
  temp INTEGER, realfeel INTEGER, humidity INTEGER, wind REAL, uvi REAL,
  iso TEXT, weathericon TEXT, weather TEXT, city TEXT, state TEXT, aqi INTEGER,
  description TEXT,
  downloadid TEXT,                          -- the watch's own downloads row
  iswatch INTEGER NOT NULL DEFAULT 1,
  server_synced INTEGER NOT NULL DEFAULT 0, -- 1 = the server has it
  phone_synced  INTEGER NOT NULL DEFAULT 0, -- 1 = the phone has it
  sync_error TEXT,
  delete_pending INTEGER NOT NULL DEFAULT 0,
  activitydetail_v2 TEXT, activitylat TEXT, activitylon TEXT, activitytimenow TEXT,
  activityelevation TEXT, activitydistance TEXT, activitybpm_v2 TEXT,
  device TEXT,
  phone_sent_at REAL,                       -- when the row was last queued for the phone (a transfer not acknowledged after 6 hours is queued again)
  CHECK (server_synced IN (0, 1)),
  CHECK (phone_synced IN (0, 1)),
  CHECK (delete_pending IN (0, 1))
);
```

A row is finished when `server_synced = 1` or `phone_synced = 1` ([watch.md](watch.md) section 3).

### Indexes

```sql
CREATE INDEX activities_start ON activities (startdate DESC);
CREATE INDEX activities_unsent ON activities (startdate) WHERE server_synced = 0 AND phone_synced = 0 AND sync_error IS NULL;
CREATE INDEX activities_delete_pending ON activities (activityid) WHERE delete_pending = 1;
```

Pruning to the newest 50 (`DELETE ... WHERE activityid NOT IN (newest 50)`) skips any row where both flags are 0.

## 2. Keychain

| Item | Holds |
|---|---|
| `refresh_token` | The watch's own refresh token, handed over once by the phone |

The access token is kept in memory only.
