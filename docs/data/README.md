# Data and sync spec

Status: proposed, agreed in chat on 2026-11-14. Covers activities (phone, watch, server), the token handover, the profile
and location, and media. Feeds, challengers, subscription and other server-sent data are not specified yet (section 2).

## Files

| File | For | Holds |
|---|---|---|
| [format.md](format.md) | everyone | The activity record, the track arrays, the compact (wire) form, the new columns, media items |
| [api.md](api.md) | server, phone, watch | Every endpoint: request, response, status codes, errors |
| [server.md](server.md) | server | Postgres changes, the upsert, deleting, media in S3, location lookup, account deletion |
| [production-checklist.md](production-checklist.md) | whoever deploys | **Everything to do before production**: schema scripts in order, scripts to run once, environment settings, code still to build. Keep it current. |
| [phone.md](phone.md) | React Native app | Stores, the activities table, the sync loop, media preparation, profile and location, logout |
| [watch.md](watch.md) | watch app | The watch's table, token from the phone, sending an activity, restore |
| [sync.md](sync.md) | server, phone | The unified sync call: one request carrying every changed section, one answer, per-section results, restore in one shot (proposed) |
| [performance.md](performance.md) | everyone | Where to make the tables and the sync processes more efficient and faster, with a read-only report ([perf-report.sql](perf-report.sql)) |
| [schema.pg.md](schema.pg.md) | server | The Postgres tables after the changes, with indexes, constraints and the migration |
| [schema.phone.md](schema.phone.md) | React Native app | SQLite, MMKV keys, Keychain items, files |
| [schema.watch.md](schema.watch.md) | watch app | The watch's SQLite table, indexes, Keychain |

When a rule appears in one file only, the other files link to it instead of repeating it. **Every table, index and constraint lives in a `schema.*.md` file**; the other files link to it.

## 1. Ground rules

1. **Offline first.** Every screen reads and writes local data. The network is a background sync.
   Nothing waits on the server (the one exception is deleting the account, [phone.md](phone.md) section 10).
2. **Every calculation is on the device:** streak, run progress, activity totals, the upload payload.
   One engine, written once as a spec with shared test vectors (section 3).
3. **The server is a storage engine.** It stores documents and returns them, fast. It builds `geom`
   and sorts by columns, nothing else. No server-side maths, no checking.
4. **Native keeps the raw data only for the length of the activity.** When the activity ends, React
   Native takes over, processes it, stores it, and native deletes its copy.
5. **The phone's database always holds the decompressed activity.** The compact form exists only on
   the wire to the server and on the server. It is made in memory just before sending and never stored on a device.
   The watch sends **compact data to the server** and **decompressed data to the phone**.
6. **No RDP in the stored data.** Ramer-Douglas-Peucker (4 m) is applied only when drawing the route
   on a map. The stored track is complete.
7. **Everything for media is prepared on the device.** The server never converts, resizes or compresses.
8. **Only one request at a time** leaves the phone's sync loop.
9. **The server caches tokens and nothing else.** The leaderboard (challengers) and the feeds are read from Postgres on each request. A cache that has to follow every customisation (who sees what, what is shared, which country) is more complex than the query it saves. Make the query cheap instead: an index that fits it, a small result, and fetch only when the screen opens. Decided 2026-11-15.

## 2. Not covered yet

Device data and reviews (small stored settings, sent when they change), feeds, challengers, subscription and other UI
data (cached with ETags). Also the **background upload mechanism** for when the app is suspended (open item 4).

## 3. Shared tests

Because the phone (TypeScript), the watch (Swift) and later Android (Kotlin) must agree exactly, keep one
folder of fixtures (JSON in, JSON out):

- compact and decompress, including empty arrays, nulls, one point, negative changes and big jumps;
- the `tosend` rules (phone first, watch first, both at once, a repeat, a deleted activity);
- the sync flags on the watch;
- RDP at 4 m on a fixed route, per piece between breaks;
- the `ipref` check ([server.md](server.md) section 7).

## 4. Open items

1. **The native media module** (`preparePhoto`, `trimVideo`, `videoFrames`) is new work on both platforms. Check that WebP encoding through libwebp is available on
   iOS in your pods, and which Android version you support (WebP lossy encoding by `Bitmap.compress` is a newer API; older versions use the older WebP option).
2. **Keyframe cuts.** Check on real clips how far a passthrough cut drifts from the chosen start and end.
3. **HDR videos.** Check that iPhone HDR clips become standard (SDR) with correct colours on both platforms, and that the streaming-friendly file layout holds on Android.
4. **Uploads while suspended.** Does the compressor's `backgroundUpload` continue when the app is not running? If not, a native upload task is needed.
5. The settings and numbers (30 s, 2048 px, 80%, 25 MB, 15 minute upload address, token lifetimes, batch sizes, 10 km, 6 hours, 24 hours) are proposals.
6. The exact list of editable columns on a resend: today `media_v2` and `description`.
7. Whether `activitydistance` stays as an array, since it can be recomputed from the coordinates.
8. I applied "increments from `startdate`" to the `t` of `activitybpm_v2` as well. Tell me if only `activitytimenow` should.
9. The deleted markers (`tosend = 0`) are kept; I assumed forever, since they are small.
10. **Account deletion** ([server.md](server.md) section 8): when the user's data is really removed (at once, or after a grace period), and what happens if they sign in again during it.
11. A VPN can make the IP lookup report another country while location is off. Accepted.
12. The `regionHint` on the first request (built as `deviceInfo.region`: api.md section 1d).
13. `seconds_from_gmt` is optional and goes stale at daylight-saving changes; `timezone` is the value to rely on.
14. ~~The old track columns.~~ Resolved: latitude, longitude (5 decimals) and time are increments; elevation and distance are actual values in metres; heart rate is an actual value per location update. The exact start point comes from `geom`.
15. ~~`usertokens.device`.~~ Decided: `deviceid` is the app's `DeviceInfo.getUniqueId()`, one row per physical device on iOS ([schema.pg.md](schema.pg.md) section 6). `device` stays the model, as information. Rows unused for 365 days are deleted ([server.md](server.md) section 9).
16. ~~`device_type_enum` needs a value for the watch.~~ Resolved: it already has `watch` (and `watchos` / `wearos` for the platform); the enum values are in [schema.pg.md](schema.pg.md) section 7.
17. **The other tables**, one at a time ([schema.pg.md](schema.pg.md) section 10). `walkdata` done; `streak_logs` paused; `app_sync`, `sync_body` and `user_sessions` are testing tables and optional, to be dropped. Not seen: `app_sync_sandbox`, `user_topics`, `weightmanagement`, `protection_logs`, `reviews` and the rest.
18. ~~`tosend` already has a meaning.~~ Resolved: it only holds 0, 1 or 2 and nothing else uses it.
19. ~~Login, refresh and logout.~~ Seen. `JWT_EXPIRY` is 7 days; the refresh token has no expiry of its own.
20. ~~A refresh whose reply is lost signs the user out.~~ Decided: the previous refresh value is accepted for 30 days, a sliding window ([server.md](server.md) section 10).
21. ~~What does iOS store in `usertokens.device`?~~ Resolved: the hardware model.
22. ~~Key `usertokens` on the device, not the model.~~ Decided: key on `deviceid` = `getUniqueId()` (not `downloadid`). `downloadid` stays a random UUID per download of the app, so it counts downloads.
23. ~~Android's `deviceid`.~~ Decided: the app creates a UUID on its first launch and keeps it ([phone.md](phone.md) section 1); a reinstall makes a new row, removed after 365 days.
24. ~~`walkdata` sync.~~ Decided: one row per user, compact arrays kept; today's plain columns are sent on every sync, the arrays once a day or when history changes, with a new column `history_base` ([format.md](format.md) section 5, [api.md](api.md) section 10, [server.md](server.md) section 11, [phone.md](phone.md) section 11).
25. **Old app versions and `walkdata`.** Old versions still send the full arrays including today, with no `history_base`. The server stores both forms; readers tell them apart by `history_base`. How long do old versions stay supported?
27. **Challengers and feeds endpoints** are not specified yet. Decided: both are read from Postgres and never cached (ground rule 9). The leaderboard for a day reads `dtgraph` and `yesterday_dtgraph` together ([server.md](server.md) section 11); it ranks by steps (`yesterday_distance` is stored, not ranked on). Open: what the challengers screen shows (top N, or near me; global or by country) and, for feeds, who sees an item and what marks an activity as shared.
28. **Deleting an activity does not remove its files in S3 yet.** The marker and the emptied columns are built; the files under `activitees/<activityid>/` go with the media slice ([server.md](server.md) section 4).
29. ~~Restore: summaries for old activities.~~ Decided against, to keep it simple: the phone restores **every activity in full**; the watch gets its own newest 50 ([api.md](api.md) section 4). Cost on a real 2,010-activity account: 3.75 MB, 41 requests. A heavy recorder with hour-long tracks is the worst case (72.7 MB for 3,000, measured on synthetic data); if that ever hurts, a summaries step can be added then.
30. ~~Which device types may use the phone's routes?~~ Decided: v3 supports the **phone and the watch**. `device_type` `phone` and `tablet` (a tablet runs the phone app) are the phone side, `watch` is the watch side; `chrome`, `mac` and a `downloads` row with no type are refused on both with 403 `WRONG_DEVICE` ([api.md](api.md) section 0). A chrome or mac client would be a new router, as in v2's `extension`.
31. **Production data to check before the migration** ([schema.pg.md](schema.pg.md) section 8, "What the real data shows"): the count of `tosend` / `iswatch` (old watch rows at `tosend = 2` would flood every phone's first inbox: decide on `UPDATE ... SET tosend = 1 WHERE tosend = 2`), and whether anything reads `geom` of old rows (12 of 85 rows in one real account have it swapped; v3 does not use it for them).
26. ~~Logout and a different account.~~ Decided: logout (which needs a connection) deletes nothing. At the next login, the same `userid` carries on syncing; a different `userid` wipes the previous user's local data first ([phone.md](phone.md) section 10).

## 5. Terms

**`dtgraph`** is a calendar date written as a number, not a moment in time. The app takes the start of the user's local day and shifts it by the time zone offset, so the number is **that date at 00:00 UTC**
(`isoDateToday()` is `dayjs().startOf('day').utc().unix() - timezoneOffset()`). So it is always a multiple of 86400 and it is the same label for everyone on that date, in every time zone. "Today" is each user's own local date,
and for ranking, users are compared on the same date label. Example: `1794614400` is `20771 × 86400`, the date 20771 days after 1970-01-01. Never convert it with a time zone.

Where it appears: the day of `walkdata`'s plain columns (`dtgraph`), the day base of the history arrays (`history_base`), the record dates (`max_steps_date`, `max_distance_date`), the entries behind `dtgraph_json` (as deltas),
and the phone's `steps_daily.day`. The `activities` table also has a `dtgraph` column; I assume it is the same date label for the activity's local day (to confirm).

