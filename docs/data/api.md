# API

Every endpoint between the phone, the watch and the server. What the server does with a request: [server.md](server.md).
What the phone and the watch do around it: [phone.md](phone.md), [watch.md](watch.md). The activity itself: [format.md](format.md).

All requests carry `Authorization: Bearer <access token>` (except login and refresh). Bodies that can be large are gzip-compressed
(`Content-Encoding: gzip`). The user is always taken from the token, never from the body. All times are epoch seconds in UTC.

## 0. Where the endpoints live

The paths in this document are written without a prefix. On the v3 server each client has its own group, as in v2 (`phone/v2`, `wearable/v2`, `store`):

| Group | Prefix | Who calls it | Token |
|---|---|---|---|
| phone | `/phone/v3/...` | the phone app | a token whose device is a `phone` or a `tablet` |
| wearable | `/wearable/v3/...` | the watch app | the watch's own token (`device_type = 'watch'`) |
| store | `/store/...` | App Store and Play Store notifications | nothing specified yet |

In the app, this version is set in one place, `src/data/api/config.ts` (`PHONE_V3`), and the calls are typed functions in `src/data/api/endpoints.ts`. The addresses: `https://apps.fitanalytica.com/phone/v3` (phone) and `https://apps.fitanalytica.com/wearable/v3` (watch). The version is part of the path so that a v4 can run beside v3 for as long as old apps need it.

A token of the other kind is refused with 403 `WRONG_DEVICE`, and so is a token of a device v3 does not support (`chrome`, `mac`, or a `downloads` row with no `device_type`). The watch's group has only what the watch calls ([watch.md](watch.md)): refresh, `me`, the activities. It has no logout and no `watch-token` (the phone calls that one, on its own group).
`GET /health` has no prefix. Example: the batch upload is `POST /phone/v3/activities/batch` from the phone and `POST /wearable/v3/activities/batch` from the watch.

## 1. Tokens and devices

| Token | Where | Life |
|---|---|---|
| Access: a signed JWT. Its payload carries `access_token`, a random value. The server keeps only the SHA-256 hash of that value in `usertokens.access_token` (older rows hold it unhashed, and the lookup accepts both) | memory only | **7 days** (`JWT_EXPIRY`) |
| Refresh: a random value, stored the same way | Keychain | no expiry of its own; the row is deleted after 365 days unused ([server.md](server.md) section 9) |

**How a request is checked (`tokenHandlerV2`).** (1) Verify the JWT's signature and expiry. (2) Look the `access_token` up in an in-memory cache (10,000 entries, 5 minutes). (3) On a miss,
`SELECT ... FROM usertokens WHERE access_token = <hash or raw> AND revoked = FALSE`. Then it attaches the `userid` to the request. The answer codes the app must act on:

| Code | Status | Means | The app |
|---|---|---|---|
| `TOKEN_EXPIRED` | 401 | The JWT has expired but the token is known | Refresh once, then retry |
| `LOGOUT` | 401 or 403 | No such token, revoked, or an invalid JWT | Log out |
| `INVALID_TOKEN_FORMAT` | 400 | Not `Bearer <token>` | A bug; do not retry |

The JWT lives 7 days, but every cache miss checks the row (`revoked = FALSE`), so a revoke (unpair, account deletion) takes effect when the entry leaves the cache: within 5 minutes, on each server instance. A refresh is needed about once a week per device.

**Change needed.** The check returns only `userid` and `applegoogleid`. This spec also needs the `downloadid` and the device kind: add `downloadid` to the `SELECT`, join `downloads` for `device_type`,
keep both in the cache entry, and attach them to the request.

**Login, refresh and logout today**

| | What it does |
|---|---|
| Login (`getAuthTokens`) | Makes two random values (access, refresh), stores their SHA-256 hashes in one `usertokens` row, and returns the plain values; the access value goes out inside a JWT `{ access_token }`. **Today** it upserts on `(applegoogleid, device)` (the model). **Decided:** it upserts on `deviceid`: `DeviceInfo.getUniqueId()` on iOS, and a UUID the app creates and keeps on Android ([schema.pg.md](schema.pg.md) section 6), so a second login from the same phone replaces that row's tokens and clears `revoked`. |
| Refresh (`{ refreshToken }`) | Finds the row by the hash (or the raw old value) with `revoked = FALSE`, makes **new** access and refresh values, replaces both, and returns `{ accessToken (JWT), refreshToken }`. The refresh token has no expiry of its own. |
| Logout (`{ refreshToken? }`) | With a `refreshToken`: revokes that row. Without one: revokes **every** row of the user, every device. |

The app refreshes only on `TOKEN_EXPIRED`, once per request, and logs out on `LOGOUT` or a refused refresh. A network error is never treated as a refusal.

Rules for this spec:
- The phone always sends its own `refreshToken` on logout, so a logout never signs the watch out by accident.
- Logout needs the server: with no connection (or a 5xx) the app stays signed in. It then deletes no local data ([phone.md](phone.md) section 10); the next login uploads whatever is unsynced.
- The watch's login (`POST /auth/watch-token`) runs the same function with the **watch's own** `device` value and `downloadid`, so it gets its own row.
- **A refresh whose reply is lost** would sign the user out: the server has already replaced the refresh value, so the retry with the old one finds no row and answers `LOGOUT`. On mobile networks this will happen.
  A refresh happens about once a week per device, so this is rare, but it means signing in again. **Decided:** the server also accepts the previous refresh value for 2 minutes ([server.md](server.md) section 10).
- The login sends `deviceid` (`DeviceInfo.getUniqueId()`), and the upsert updates `downloadid`, `userid` and the rest on a repeat login ([schema.pg.md](schema.pg.md) section 6).

- **The `downloads` table is the device list.** Each install (phone or watch) has its own `downloads` row
  (`device_type`, `is_watch_paired`, `fcm_token`, `userid` once signed in). No new device table is needed.
- `POST /auth/watch-token` (called by the phone with its own access token) creates a *separate* `downloads` row for the watch (`dk = watch`, linked to the user)
  and returns the watch's own refresh and access tokens. How they reach the watch: [watch.md](watch.md) section 2.
- **Never copy the phone's refresh token to the watch.** With rotation, two devices using one token log each other out.
- `DELETE /devices/{downloadid}` (unpair) revokes that device's refresh token and clears `is_watch_paired` on the phone's row.

## 2. Upload a batch

`POST /activities/batch`, gzip-compressed.

```json
{ "activities": [
  { "activityid": "…", "userid": "…", "startdate": 1731480000, "enddate": 1731483600,
    "duration": 3600, "stepcount": 8123, "distance": 9210,
    "lat": 12.971599, "lon": 77.594566, "downloadid": "…", "iswatch": false,
    "activitydetail_v2": { "enc": 1, "tz": 19800, "breaks": [] },
    "activitylat": [0, 12, 15], "activitylon": [0, -4, -3],
    "activitytimenow": [1731480000, 1, 2], "activityelevation": [903.4, 903.4, 903.5],
    "activitydistance": [0, 3.1, 6.0], "activitybpm_v2": null,
    "media_v2": [] }
] }
```

`media_v2` is empty here: the media files follow (section 6) once the activity is on the server.
The same endpoint is used for a **repeat** of an activity that was edited ([server.md](server.md) section 2).

Limits (proposed): 20 activities and 1 MB compressed per request. A single activity bigger than that is sent alone, up to 5 MB.

Response: HTTP 200 even if some items failed.

```json
{ "results": [
  { "activityid": "…", "status": "created", "tosend": 1 },
  { "activityid": "…", "status": "exists",  "tosend": 1 },
  { "activityid": "…", "status": "deleted", "tosend": 0 },
  { "activityid": "…", "status": "invalid", "error": "not_owner" }
] }
```

| Status | The client |
|---|---|
| `created`, `exists` | marks the row synced (phone: `synced = 1`; watch: `server_synced = 1`) |
| `deleted` | the activity was deleted on another device: delete the local row and its media files |
| `invalid` | writes `sync_error`, stops retrying that row until the app is updated, shows nothing to the user |
| item missing from `results` | treated as not sent, retried |

**What the server does (v3, built).**
- The whole request is refused with 400 `BAD_BATCH` only when `activities` is not a non-empty array or has more than 20 items. Anything else is answered per item.
- `results` has one entry per item, **in the order sent**. The same `activityid` twice in one request: one row is written, the later item wins, and both are answered.
- `userid` in the body is ignored: the owner is always the token's user. `downloadid` is optional (it defaults to the token's own device); if given it must be a `downloads` row of this user.
- `lat` and `lon` are always required (a resend too), because `geom` is NOT NULL. The track arrays and `activitydetail_v2` may be left out of a **resend**: they are never changed by one.
- `dtgraph` is accepted and stored if sent (an integer date label, README section 5); the app should send it. The server does not compute it.
- `invalid` reasons (`error`): `bad_activityid`, `not_an_object`, `bad_dates` (not integer seconds, or `enddate` before `startdate`), `bad_location`, `bad_duration`/`bad_stepcount`/`bad_distance`, `bad_temp`/`bad_realfeel`/`bad_humidity`/`bad_aqi`,
  `bad_wind`/`bad_uvi`, `bad_<text column>`, `description_too_long` (over 200), `bad_iswatch`, `bad_track` (an array that is not an array, or arrays of different lengths), `bad_activitydetail_v2`/`bad_activitybpm_v2`/`bad_device`, `bad_media`,
  `missing_activitydetail_v2` (a row that carries a track must carry `activitydetail_v2`: it is what marks the row as new-format, see section 4), `bad_downloadid`, `not_owner` (the id belongs to another user), `rejected` (the database refused this item).
- `iso`, `weathericon`, `weather`, `city` and `state` are cut to their column length instead of refused.

## 3. The phone's inbox

Watch activities the phone has not seen.

- `GET /activities/inbox?limit=20` returns `{ "activities": [ … ] }`: the user's watch activities where `tosend = 2`, oldest first, in the compact form, with the same field names as an upload
  (`lat` and `lon` are the exact start point; there is no `userid` and no `tosend`). `limit` is 1 to 50 (default 20), anything else is 400 `BAD_REQUEST`. With `limit`, the **oldest** items are returned first.
- `POST /activities/ack` with `{ "ids": ["…"] }` (1 to 100 uuids) answers `{ "acked": ["…"] }`: only ids that are the user's and still `tosend = 2`. A repeat answers `{ "acked": [] }`, so the loop "fetch, store, ack, repeat until empty" always ends.

Phone only: a watch token is refused (403 `WRONG_DEVICE`) and the watch's group has no inbox.

What the phone does with them: [phone.md](phone.md) section 8.

## 4. Restore

`GET /activities?limit=50&before=<cursor>` returns `{ "activities": [ … full … ], "next": "<cursor>" | null, "total": n | null }`, **all** of the user's activities **in full**, newest first.
`limit` is 1 to 50 (default 50). The cursor is `<startdate>.<activityid>`. `total` (all of the user's activities) is on the **first page only**; it is `null` on a page that has a `before`. Deleted markers (`tosend = 0`) are never returned, and only the user's own activities are.
`next` is the cursor of the page's last row, and `null` on the last page. The cursor is a keyset (`startdate`, then `activityid`), so a page never shifts when a newer activity arrives and activities with the same start time are never skipped.

**Decided: the phone restores everything, in full.** No summaries, no size rule, no second step: the phone takes pages until `next` is `null` ([phone.md](phone.md) section 8).

A **full** activity is the upload's field names plus `lat` and `lon` and, for an old-format row, its old columns (`media`, `media_details`, `activitydetail`, `activitybpm`; [format.md](format.md) section 3).
**`lat` and `lon` in a reply:** for a **new-format** row (`activitydetail_v2` present) they are the exact start point from `geom`, which the compact arrays are relative to. For an **old-format** row they are the `lat` and `lon` columns and `geom` is never used: in production some old rows have a wrong `geom`
(`lat` and `lon` swapped, or `(0, 0)`; in one real account 12 of 85 rows), so trusting it would draw those routes in the wrong place ([format.md](format.md) section 2).

**What it costs** (local database, gzip level 1). On a **real account** of 2,010 old-format activities, mostly short walks and runs (about 2 KB each): **41 requests, 3.75 MB over the wire, 0.49 s of server time**.
A heavy recorder is the worst case: 3,000 synthetic one-hour activities (3,600 points each) came to 60 requests, 72.7 MB and 4.5 s, because a page of 50 is then about 1 MB compressed. That is accepted for now.
The replies are gzip at level 1: a page of 50 hour-long activities is about 4.7 MB of JSON, and level 6 costs about 174 ms of CPU per page against 21 ms at level 1, for about 20% more bytes.

**The watch:** `GET /wearable/v3/activities?limit=50`, once, on install ([watch.md](watch.md) section 4). The server always returns **only the watch's own activities** (`iswatch`), newest first: the watch cannot ask for the phone's, and it has no cursor (no paging). `limit` is 1 to 50 (default 50); `total` counts only the watch's own.
Errors: `limit` out of range, or (phone) a bad cursor, is 400 `BAD_REQUEST`.

## 5. Delete an activity

`DELETE /activities/{activityid}` answers 204 when it is deleted, or 404 for an unknown id (the client treats 404 as success). A repeat of a delete answers 204. The id of **another user's** activity answers 404 too, so it does not reveal that it exists. A malformed id is 400 `BAD_REQUEST`. The phone and the watch both call it, each with its own token.
What the server removes: [server.md](server.md) section 4. What the client does first and after: [phone.md](phone.md) section 5, [watch.md](watch.md) section 5.

## 6. Media (a pre-signed upload)

File bytes never go through the API. For each file:

1. `POST /media/:actid/presign` with `{ "role": "photo" | "video" | "poster", "contentType": "image/webp", "bytes": 312345 }`.
   The server checks that the activity is the user's and not deleted (`tosend > 0`), checks `bytes` against the cap for the role,
   chooses the name (`<uuid>.<ext>` from the content type), and answers
   `{ "value": "6f1c…2e.webp", "url": "<pre-signed PUT address>", "headers": { … } }`. The address is valid for about 15 minutes and is
   signed for this exact key, content type and length.
2. The app uploads the file with `PUT url`.
3. `POST /media/:actid/commit` with `{ "value": "…", "type": "photo", "dimension": [w, h], "duration": 12.4, "poster": "<poster value>" }`.
   The server checks the owner and `tosend > 0`, checks the file exists with the right size and type, and appends the item to `media_v2`
   ([server.md](server.md) section 6). If no row was updated it deletes the file and answers 404. It never converts or reads the picture.

A **video's poster** is uploaded first (steps 1 and 2 with role `poster`) and is **not committed on its own**: the video's commit carries its `poster`
value. The activity must already be on the server. Media is uploaded one file at a time, in order, so the list keeps its order.

The old `POST /media/:actid` (multipart, converts on the server) stays for older app versions and is not used by the new format.

## 7. Profile and location

| Endpoint | Does |
|---|---|
| `GET /profile` | Returns `{ "profile": { … }, "account": { "email", "loginused" } }`: the user's `userinfo` row without `geom`, `store_id`, `mailids` and `deleted_date`, and the e-mail and login method from `userlogin`. `profile` has `fname`, `lname`, `about`, `gender`, `dobglobal`, `height`, `weight`, `hideprofile`, `timezone`, `iso`, `city`, `state`, `lat`, `lon`, `profilepic`, `profilebg`, `dateregistered`, `last_access_date`, `geo_source`, and **`country`**, the name of the country of `iso` from the server's list (`null` with no place, or a code that is not in the list). **404 `NOT_FOUND` when the user has no `userinfo` row yet: the app reads that as a new user** and goes to the setup steps. Phone only (the watch never reads the profile). Built in v3. |
| `PUT /profile` | Sets the editable fields (`fname`, `lname`, `about`, `gender`, `dobglobal`, `height`, `weight`, `hideprofile`, `timezone`). The last write wins. |
| `PUT /profile/location` | `{ lat, lon, city, state?, iso }` from the phone's GPS. Exact coordinates (stored as doubles in `geom`; the `lat` and `lon` columns are REAL). Sets `geo_source = 2`. Answers `{ lat, lon, city, state, iso, country }` as saved. **The country's name is not sent and not stored: the server looks it up from `iso` in its own list** (250 entries, `services/location/countries.ts`). `iso` is checked against that list and stored upper case. `lat` in -90 to 90, `lon` in -180 to 180, `city` 1 to 100 characters (cut to 50 for the column), `state` optional (empty means none, `NULL`). **(0, 0) is refused**: it is what a failed fix looks like. Refused: 400 `BAD_REQUEST`. **404 `NOT_FOUND` while the user has no profile row yet** (the setup steps are not saved): the phone keeps the fix and sends it again after the profile. Phone only. Built in v3. |
| `POST /profile/media/presign`, `POST /profile/media/commit` | The profile picture and the cover, same steps as section 6 (`role`: `profilepic` or `profilebg`, bucket `fitpy`). |

Two headers on requests, and one on responses, for the location ([server.md](server.md) section 7):
- `X-Location: on | off` (request): whether location permission is granted.
- `X-Ipref: <value>` (request): the last `ipref` the app received.
- `ipref` (response): the value to send back next time.

## 8. Delete the account

`DELETE /account` answers 204. It needs a connection and is never queued. What happens: [server.md](server.md) section 8,
[phone.md](phone.md) section 10.

## 9. Errors and retries

| Situation | What happens |
|---|---|
| 400 `BAD_REQUEST` | The body, query or id does not match the schema (the `message` names the field). A bug in the app; do not retry. |
| No network | Nothing is lost. The row stays unsynced and is retried by the triggers ([phone.md](phone.md) section 4). |
| 401 `TOKEN_EXPIRED` | One refresh, one retry. A refused refresh logs out. |
| 401 or 403 `LOGOUT` | Log out. |
| 413 or 400 for the whole request | Send the items one at a time. The one that fails alone is marked `invalid`. |
| 5xx or a timeout | Retry with the back-off. Safe to repeat. |
| App killed mid-upload | Safe. The batch repeats with the same ids. |

## 10. Step history

| Endpoint | Does |
|---|---|
| `PUT /walk/today` | Today's plain columns, sent on every sync: `{ dtgraph, stepcount, distance, ascend, descend, max_steps, max_steps_date, max_distance, max_distance_date, steps_goal, yesterday? }`, where `yesterday` is `{ dtgraph, stepcount, distance }` for the day before (`dtgraph - 86400`), sent whenever the phone has a row for it, for yesterday's leaderboard. A few hundred bytes. Answers 204, or 400 `bad_dtgraph` / `bad_yesterday` ([server.md](server.md) section 11). |
| `PUT /walk/history` | The arrays, gzip-compressed: `{ base, dtgraph_json, stepcount_json, ascend_json, descend_json, distance_json, iso_json }`, where `base` is the day the deltas were encoded against. Sent once a day, when a day closes, or when history changes. Answers 204. |
| `GET /walk` | The user's row: the plain columns, the arrays and `history_base`. Used on a restore. |

`dtgraph` is a date label, not a moment ([README](README.md) section 5). What the server does: [server.md](server.md) section 11. What the phone does: [phone.md](phone.md) section 11. The formats: [format.md](format.md) section 5.
