# Efficiency and speed

A review of every table and sync process in [README.md](README.md) for **less work** (efficiency) and **less waiting** (speed). Nothing here has been measured: the numbers are my reasoning from the schema and the code you pasted.
[perf-report.sql](perf-report.sql) measures it (biggest tables, write rates, unused and duplicate indexes, the costliest queries). Run it first, then decide. Run it on the **primary** (with a read-only role): a reader only counts its own reads, so write rates and index use would look empty.

Effort: **S** = a few hours, **M** = a few days, **L** = a week or more.

## 1. The request path (every call)

| # | Change | Why | Effort |
|---|---|---|---|
| 1 | **Token check: fall back to the writer before answering `LOGOUT`.** | A login or refresh writes on the writer; the next request reads on the reader. If the reader is a moment behind, the new token is not there yet and the user is signed out by mistake. A miss on the reader should try the writer once. | S |
| 2 | **Cache a "no" too**, for about 30 seconds. | An unknown or revoked token goes to the database on every request today. A bad client can hammer it. | S |
| 3 | **Put `downloadid` and the device kind in the cache entry** (the change already agreed). | No extra query per request. | S |
| 4 | **Migrate the old raw tokens to hashes, then drop the `OR` raw lookup.** | `access_token = $1 OR access_token = $2` makes the planner combine two index scans; one equality is cheaper. | S |
| 5 | **Throttle the "last seen" writes.** `usertokens.accessed_date` already writes once an hour. Do the same for `userinfo.last_access_date` and the `downloads` counters (`last_access_date`, `total_session_count`, `total_session_duration`): one write per hour per user, or add up in memory and flush every minute. | A write on every request is the most expensive thing a hot path can do. | S |
| 6 | **Rate limit** (for example `PUT /walk/today` at most once a minute per user, in memory). | Protects the database from a client bug. | S |
| 7 | **Do not parse and re-stringify the big arrays.** Make the `pg` driver return `json` and `jsonb` columns as text (`setTypeParser`), or `SELECT col::text`, and send that string. On writes, avoid parsing the arrays only to serialise them again. | The activity arrays can be tens of KB; parsing them in Node twice per request is CPU for nothing. | M |

## 2. Writes

| # | Change | Why | Effort |
|---|---|---|---|
| 8 | **Batch upsert in one statement** (`INSERT ... VALUES (...), (...) ON CONFLICT`, or `unnest`) for the 20 activities of `/activities/batch`. | One round trip instead of 20. | M |
| 9 | **Store the JSON columns with lz4:** `ALTER TABLE ... ALTER COLUMN ... SET COMPRESSION lz4`, and `default_toast_compression = lz4`, on `activitylat`, `activitylon`, `activitytimenow`, `activityelevation`, `activitydistance`, `activitydetail_v2`, `activitybpm_v2`, the `walkdata` `_json` columns and `streak_logs.daily_logs`. | lz4 is much faster than the default `pglz` for similar size (Postgres 14 and later). New values only. | S |
| 10 | **`walkdata`: drop `idx_walkdata_dtgraph_stepcount`** (measured: 0 scans). It is the same index as `idx_walkdata_dtgraph_stepcount_filter`, which is the one in use (an index can be read backwards). Check the scans of `idx_walkdata_userid_dtgraph` before touching it: it was not among the least-used 30, so it is in use. | `PUT /walk/today` changes `dtgraph` and `stepcount`, which are indexed, so every sync updates every index (`walkdata` updates are only 50% HOT). Fewer indexes, fewer writes. | S |
| 11 | **Send today's steps less often:** at most every 5 minutes while the app is open, and once when it goes to the background. | Ranking does not need second-by-second numbers, and it cuts writes by a large factor. | S |
| 12 | **Stop writing `sync_body` and one `app_sync` row per sync** (once old app versions are gone). `sync_body` rewrites a copy of everything on every sync; `app_sync` appends a row with a random UUID key (page splits in the index) per sync, forever. Replace with `last_sync_date` and a counter on `downloads`, updated at most hourly. | The biggest pure overhead I can see. | M |
| 13 | **Autovacuum and fill factor for the hot tables** (`walkdata`, `usertokens`, `downloads`): a lower `autovacuum_vacuum_scale_factor` (for example 0.02) and `fillfactor = 80`. | Frequent updates leave dead rows; this keeps them cleaned and lets cheap (HOT) updates happen where no indexed column changes. | S |

## 3. Reads

| # | Change | Why | Effort |
|---|---|---|---|
| 14 | **Read on the reader, except where you just wrote.** Restore, lists and leaderboards go to the reader; the inbox and the ack stay on the writer. | Offloads the writer without stale reads where they matter. | S |
| 15 | **ETag or `If-Modified-Since` on `GET /profile`, `GET /walk` and settings**, answered from a light query (`SELECT ddate`), with 304 and no body. | The big arrays are never read when nothing changed. | S |
| 16 | **Cache the leaderboards** (top N per `dtgraph`) in memory for 30 to 60 seconds, and answer "my rank" from a cheap count. | Many users ask for the same list. | M |
| 17 | **Drop the unused indexes** (section 10): the duplicates `idx_usertokens_applegoogleid_device` and `idx_user_topics_unsubscribed_downloadid`, then, after checking the statistics window, the zero-scan ones. Keep `idx_activities_userid`, `idx_activities_downloadid` (foreign keys) and `idx_downloads_active_tokens` (push targeting, used rarely but large). | Every index is paid for on every write. | S |
| 18 | **One round trip at launch.** The app sends the version it has for each resource (`profile`, `walk`, `settings`); the server answers with only what changed. | One call instead of five or six when the app opens. | M |

## 4. Sync processes (phone and watch)

| # | Change | Why | Effort |
|---|---|---|---|
| 19 | **Media: one `presign` call for all files, upload the files 2 or 3 at a time, one `commit` with the whole list in order.** | A story with 5 pictures is 15 serial requests today, and about 3 round trips plus the uploads with this. The serial rule only needs to hold between API calls, not between uploads to S3. | M |
| 20 | **Serve media through a CDN** with a long cache time. The names are unique and never change, so they can be cached forever. | Pictures and videos load from a nearby cache, not from S3. The biggest speed gain for feeds. | S |
| 21 | **A small copy of each picture** (about 640 px, `<uuid>_s.webp`) made on the phone at the same time. The feed uses it, the viewer uses the full one. | A feed shows many pictures at once; this cuts the data per card a lot, for about 15% more storage. | M |
| 22 | **Inbox: send the acknowledgement with the next inbox request** (`GET /activities/inbox?ack=id1,id2`). | Saves a round trip per cycle. | S |
| 23 | **Restore: pages by size** (about 500 KB) instead of 50 activities, and decode and insert on a background thread. | A restore of hundreds of activities should not block the screen. | M |
| 24 | **A silent push instead of polling for the inbox** (the server sends one when the watch uploads). | No checking on every foreground. | M |
| 25 | **Local SQLite settings:** WAL (already), `synchronous = NORMAL`, `temp_store = MEMORY`, one transaction per batch, prepared statements. | Faster commits and inserts. | S |
| 26 | **HTTP/2 with keep-alive and gzip** everywhere (arrays compress very well). | Fewer connections and fewer bytes. | S |

## 5. Tables

- **`activities`:** if lists are ever slow, move the track arrays to a table of their own (`activity_tracks`, one row per activity), so the main table stays narrow. Not needed yet; the rule is to never `SELECT *` from it.
- **`walkdata`:** items 10, 11 and 13 above; the per-day row design stays rejected.
- **`streak_logs`:** the index `(userid, duration DESC)` starts with `userid`, so it cannot rank all users by duration. Check what the leaderboard query is when we come back to this table.
- **`usertokens`:** the hash columns could be `bytea` (32 bytes) instead of 64-character text, which halves their index. Low priority.
- **Account deletion** touches about twenty tables through the cascade: run it as a background job in small steps, not inside one request.
- **The tables I have not seen** (`apperrors`, `app_actions`, `user_sessions`, `protection_logs`, `offers_displayed` and others) are the likely biggest growers. Section 1 of the report lists them by size.

## 6. What I would do first

1. Run [perf-report.sql](perf-report.sql) and look at sections 1, 2, 3 and 5.
2. The quick wins, all small: items 1, 2, 5, 9, 10, 11, 20.
3. Then item 12 (the `sync_body` and `app_sync` overhead) and item 8 (batch upsert).

## 7. First measurements (section 1 and 6 of the report, one run)

The whole database is small, about 200 MB for 4,500 users, so nothing is slow today. What the numbers show is where it will grow fastest:

| Table | Rows | Size | What it is |
|---|---|---|---|
| `app_sync` | 330,889 | 54 MB (indexes 26 MB) | a log row per sync, about 73 rows per user |
| `activities` | 12,142 | 31 MB | |
| `user_sessions` | 253,073 | 30 MB | a log row per session, about 56 rows per user |
| `sync_body` | 3,220 | 24 MB | a copy of the last sync, about 7.5 KB per user; **3.5 times the size of `walkdata`** |
| `walkdata` | 2,606 | 6.9 MB | |
| `notification_queue` | 18,051 | 6.9 MB (indexes 3.7 MB) | |
| `usertokens` | 4,074 | 3.9 MB (indexes 2.7 MB, more than the table) | |

- **`app_sync`, `user_sessions` and `sync_body` are about half of the database** (108 of about 215 MB), and none of them holds anything the app needs that is not stored elsewhere. They are the first thing to fix (items 12 and 27).
  At one million users the two logs alone would be tens of GB.
- **27. Give the logs a life.** `app_sync` and `user_sessions`: keep 90 days (a daily delete in small batches, or monthly partitions that are dropped), and keep the totals on `downloads` instead.
- **`activities` rows are wide** (about 1.7 KB in the table itself, because the arrays are small enough to stay inline). Lists stay quick at this size; if they slow down, move the arrays to their own table (section 5).
- **All JSON columns use the default compression** (section 6), so item 9 (lz4) applies to all of them. It only changes values written after the change.
- **`userinfo` has 4,604 rows and `userlogin` 4,539**: about 65 rows left from deleted accounts, as expected without a foreign key. The account deletion steps ([server.md](server.md) section 8) remove them.
- **`pg_stat_statements` is not installed.** Add it (`CREATE EXTENSION pg_stat_statements`, and set it in `shared_preload_libraries`) to see which queries cost the most; it is the best tool for the next round.

Not yet seen (the pasted run broke sections 2, 3, 4, 7 and 8): the write rates and HOT share, the unused and duplicate indexes, the settings, and the cache hit ratio. Run the report with `-f`.

## 8. Write rates (section 2 of the report, one run)

Counts since the statistics were last reset. The figures in the last column are my estimate: updates times the row sizes from section 7.

| Table | Inserts | Updates | HOT | Deletes | About how much is rewritten |
|---|---|---|---|---|---|
| `sync_body` | 3,288 | 546,229 | 95% | 68 | ~4 GB (7.5 KB per update) to keep 24 MB |
| `walkdata` | 2,323 | 552,917 | **50%** | 51 | ~1.4 GB (2.6 KB per update) |
| `userinfo` | 4,054 | 583,654 | 98% | 12 | ~0.6 GB |
| `usertokens` | 3,897 | 626,444 | 97% | 385 | small rows |
| `weightmanagement` | 968 | 222,895 | 99.7% | 15 | small rows, ~200 updates per row |
| `downloads` | 7,328 | 207,076 | 94% | 133 | |
| `app_sync` | 585,569 | 0 | | 322,699 | |
| `streak_logs` | 54 | 10,900 | 96% | 6 | ~200 updates per streak |

- **One sync is about seven writes.** The update counts of `sync_body`, `walkdata`, `userinfo` and `usertokens` are all 550,000 to 630,000, next to 585,000 `app_sync` inserts. Every sync inserts an `app_sync` row and updates `sync_body`, `walkdata`, `userinfo` and `usertokens`, and several others.
- **`sync_body` is the worst:** about 4 GB rewritten (Postgres writes a new copy of the JSON value, and its log, on every update) to keep a 24 MB table. Then `walkdata` at about 1.4 GB. Together that is roughly 5 GB of writes for 31 MB of data.
- **`userinfo` has 144 updates per row:** a wide row (about, picture names) rewritten on every sync, almost certainly for `last_access_date`. Item 5 (one write an hour) removes nearly all of it.
- **`walkdata` updates are only half HOT**, as predicted: `dtgraph` and `stepcount` are indexed, so every other update also maintains the indexes. Dropping the two redundant indexes and sending today's steps less often (items 10 and 11) cut this.
- **`app_sync` already has deletes** (322,699), so something trims it. 330,889 rows remain: what is the retention?
- **HOT is 94 to 99% almost everywhere else**, so those tables are healthy. Autovacuum has run recently on the hot tables.
- **Scale today.** If the counters cover about 15 months, 585,000 syncs is about 1,300 a day, around one every minute. Nothing is under pressure now; these changes are for growth, where every sync costing seven writes would hurt at a hundred times the users.
- **With the agreed design,** a sync writes today's plain `walkdata` columns (once every few minutes) and nothing else. That is one small update instead of seven.

Still missing from the run: the unused and duplicate indexes (sections 3 and 4), the settings (section 7) and the cache hit ratio (section 8).

## 9. Decided: drop `sync_body`, `app_sync` and `user_sessions`

You confirmed all three are testing tables and optional. So:
1. Turn off the server code that writes them (a flag, then remove it), and check nothing else reads them (search for `app_sync`, `sync_body` and `user_sessions`).
2. Keep a copy first: `pg_dump -t app_sync -t sync_body -t user_sessions ... > backup.sql`.
3. `DROP TABLE app_sync, sync_body, user_sessions;` ([schema.pg.md](schema.pg.md) section 8, step 6).

What that removes, from the measurements: 108 MB of about 215 MB (**half of the database**), about 1.07 million inserts, 546,000 large updates (about 4 GB of rewriting) and 48,000 more updates.
A sync then drops from about seven writes to about five, and the throttling in items 5 and 11 takes it to one.
The `downloads` columns `total_session_count` and `total_session_duration` are separate and stay. If anything computes them from `user_sessions`, it needs to read them from somewhere else first.
The next tables by size are `activities` (31 MB, real data), `walkdata` (7 MB), `notification_queue` (7 MB, 18,000 rows), `usertokens` and `downloads` (4 MB each), `apperrors` (3 MB).

## 10. Indexes, settings and cache (sections 3, 4, 7, 8 of the report)

**The cache is not the problem.** The hit ratio for tables is **0.9999**, `shared_buffers` is 2 GB and the whole database is about 215 MB, so every read comes from memory. The cost today is writes, connections and the work the server does per request, not disk reads.

**Duplicate indexes** (section 4): three pairs.
- `usertokens`: `unique_applegoogle_device` and `idx_usertokens_applegoogleid_device`. The unique one goes with the move to `deviceid`; drop the plain one now.
- `user_topics`: `idx_user_topics_unsubscribed_downloadid` and `idx_user_topics_downloadid_false`. Drop the first (0 scans).
- `walkdata`: `idx_walkdata_dtgraph_stepcount` and `..._filter`. Drop the first (0 scans); keep `_filter`, which is used.

**Never used since the last reset** (section 3, 0 scans), sizes in brackets. Small today; it is housekeeping and write cost that grows with the data:
- `user_topics`: `idx_user_topics_lookup` (640 kB), `idx_user_topics_topicid_subscribed` (600 kB).
- `userinfo`: `idx_userinfo_visible_profiles` (312 kB), `userinfo_geom_idx` (232 kB; keep it if a "near me" feature is planned), `idx_userinfo_storeid_userid` (232 kB).
- `notification_queue`: `idx_notification_queue_pending` (88 kB).
- `activities`: `idx_activities_valid_media` (32 kB, the old media column).
- `streak_logs`: `idx_streak_logs_leaderboard` (16 kB): the leaderboard is not used yet.
- Barely used: `idx_activities_tosend_enddate` (4 scans, 416 kB), `userinfo_iso_idx` (1), `idx_userinfo_dateregistered` (2).
- **How long the counters cover.** `stats_reset` is empty: the statistics were never reset. The oldest `last_autovacuum` in section 2 is 2025-08-18, so the counters cover **at least 15 months**. A zero-scan index over that time is unused, unless a yearly job needs it. Confirm with `SELECT pg_postmaster_start_time();` and `SELECT to_timestamp(min(dateregistered)), to_timestamp(max(dateregistered)) FROM userinfo;`.

**Settings** (section 7):
- `default_toast_compression` is `pglz`: change it to `lz4` (item 9).
- `max_connections` is 401. That is a lot for a database this size: each connection uses memory. Check the size of the server's connection pool, and use a pooler (the provider's proxy or pgbouncer) so that a few dozen real connections serve all the instances.
- `shared_buffers` 2 GB and `effective_cache_size` 2 GB are fine at this size. `effective_cache_size` is normally set to about three quarters of the machine's memory; it does not matter until the data outgrows memory.
- `work_mem` 4 MB is the default and fine.

