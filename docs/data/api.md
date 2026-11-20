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

## 0b. What moved into `POST /sync`

The phone does not call a route for each of these any more: they are **sections of one call**, `POST /phone/v3/sync` ([sync.md](sync.md)), and **the old phone routes were removed** (the watch's own routes stay).

| Removed phone route | Is now |
|---|---|
| `POST /activities/batch` | `up.activities.send` (up to 20 items; the answer has one result per item) |
| `DELETE /activities/:activityid` | `up.activities.delete` (up to 20 ids; `ok`, or `NOT_FOUND` which counts as done) |
| `GET /activities/inbox`, `POST /activities/ack` | `up.inbox = { ack?, pull? }`; the activities come back in `down.inbox` |
| `PUT /profile`, `PUT /profile/visibility`, `PUT /profile/location` | `up.profile = { put?, visibility?, location? }` |
| `PUT /device` | `up.device` |
| `GET /me/state` | `up.state = { platform?, catalog?, ads? }`; the state comes back in `down.state` |
| `PUT /walk/today`, `PUT /walk/history` | `up.walk = { today?, history? }` |
| `GET /activities` (the phone's restore) | `restore = { walk?, activities?: { before?, limit? } }`; the answer is `down.restore = { walk?, activities? }` ([sync.md](sync.md) section 5) |
| `GET /me` | removed (nothing used it) |

**Still their own routes:** sign-in, refresh, logout, delete account, `GET /profile` (the sign-in decides on it: 404 is a new user), the watch's `GET /activities`, media and profile images, posts, feed, users, weather, purchases and redeem. A section's body has the same fields and rules as the route it replaced; a body that does not match fails **that section only** (`BAD_REQUEST`), never the whole call. Where the sections below show a route, read it as the section above.

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
  A refresh happens about once a week per device, so this is rare, but it means signing in again. **Decided:** the server also accepts the previous refresh value for 30 days (a sliding window) ([server.md](server.md) section 10).
- The login sends `deviceid` (`DeviceInfo.getUniqueId()`), and the upsert updates `downloadid`, `userid` and the rest on a repeat login ([schema.pg.md](schema.pg.md) section 6).

- **The `downloads` table is the device list.** Each install (phone or watch) has its own `downloads` row
  (`device_type`, `is_watch_paired`, `fcm_token`, `userid` once signed in). No new device table is needed.
- `POST /auth/watch-token` (called by the phone with its own access token) creates a *separate* `downloads` row for the watch (`dk = watch`, linked to the user)
  and returns the watch's own refresh and access tokens. How they reach the watch: [watch.md](watch.md) section 2.
- **Never copy the phone's refresh token to the watch.** With rotation, two devices using one token log each other out.
- `DELETE /devices/{downloadid}` (unpair) revokes that device's refresh token and clears `is_watch_paired` on the phone's row.

**What the phone does so a sign-in is never lost** (`src/data/api/session.ts`; the rule: **a sign-in is never thrown away on doubt**):
- A Keychain read that returns nothing is repeated (after 150 and 600 ms) before it is believed; one that throws is not "empty": nobody is signed out, no request is made, and the stored value stays.
- A refresh that is **refused** is checked against what is stored now: if another refresh has replaced the value it sent (a second run of the app, an overlapping reload), the newer one is used. Only a refusal of the very value that is stored is the server's real answer.
- A network error, a 5xx, an unreadable Keychain or a failed write never sign out. A write of the new refresh value that fails is retried, and if it still fails the old value is kept (the server still accepts it: [server.md](server.md) section 10).
- A request answered `LOGOUT` first tries the refresh value; only if the server refuses that too is the sign-in over.
- When the server really ends the sign-in, the app is told `expired` (not `user`): **nothing is wiped** (the feed cache, the posts, the activities stay), the app returns to the Welcome screen, which says so ("You were signed out. Sign in again and everything carries on: your posts and activities are kept."), and signing in again as the same person carries on. Only the user's own sign-out clears what is of other people (the feed cache), and a different account signing in clears the previous account's data.
- The last 20 things that happened to the sign-in (refreshed, refused with which code, Keychain trouble; with the time, and never a secret) are kept (`readAuthLog()`), so a lost sign-in can be explained.

## 1b. Sign in with Apple and Google

`POST /auth/login` (open to anyone; limited to `LOGIN_RATE_LIMIT` tries a minute per address, 20 by default). The app shows Apple's or Google's own sheet and sends what it gives; **the server decides who the user is**, never the app.

Body: `{ provider: "apple" | "google", idToken, nonce?, authCode?, fullName?, deviceid, downloadid?, device?, platform? }`.
- `idToken` is checked against the provider's published keys (cached): the signature (RS256), the issuer, the audience (**our own app**: `APPLE_CLIENT_ID`, which is the bundle id `com.fitanalytica`; for Google `GOOGLE_CLIENT_IDS`, the app's OAuth client ids: **the iOS client for an iPhone and the project's WEB client for an Android phone** (Android's Google sign-in only gives an ID token when the app names the web client, and the token's audience is then that client), comma-separated) and the expiry (30 seconds of clock tolerance). Anything wrong is **401 `LOGIN_REFUSED`**; a provider with no id set on the server is **503 `LOGIN_REFUSED`**.
- `nonce` is the raw value the app made for this sign-in. **Apple:** the token holds what the app sent Apple, so it must match (as the raw value or its SHA-256), and a token without one is refused when the app sent one. **Google:** the iOS SDK puts a nonce of its own in the token that the app never sees, so with no `nonce` from the app there is nothing to compare and the token is accepted (its short life and audience still hold); when the app does send one, it must match.
- The user is the token's `sub`, kept in `userlogin.applegoogleid` (50 characters at most). The first sign-in makes the `userlogin` row (`loginused`, `email`; an address longer than the column's 60 characters is left out, never cut); a repeat finds it, on any device. **No profile is made here**: whether the user is new is whether `GET /profile` is 404, as ever, and `PUT /profile` makes it ([section 7](#7-profile-and-location)).
- Apple only: `authCode` is exchanged with Apple (`/auth/token`, with a client secret signed by the account's Key) for Apple's **refresh token**, kept in `usertokens.apple_refresh_token` for this device, so that **deleting the account can revoke the grant** (`/auth/revoke`). If the exchange fails the user is still signed in. `fullName` is what Apple gave **the first time only**; it is passed back as the app sent it.
- `deviceid` is the install's device id (one `usertokens` row per device), `downloadid` its download row (made if missing).

Answer: `{ accessToken, refreshToken, userid, downloadid, email, givenName, familyName }`. The tokens are the usual ones ([section 1](#1-tokens-and-devices)): **nothing ends the session except logout or a token the server refuses**. `givenName` and `familyName` start a new user's profile name (Google's token has them; Apple's come from `fullName`).

`POST /auth/dev-login` (`DEV_LOGIN=true` only) stays for local test users.

**Logging out** is `POST /auth/logout` with this device's refresh token ([section 1](#1-tokens-and-devices)); the phone needs the server for it (offline, the user stays signed in and is told to connect), except when the user removed the app from their Apple ID, which signs them out regardless ([phone.md](phone.md) section 9b).

## 1c. The location headers (phone routes)

Every request of the signed-in phone carries **`X-Location: on` or `off`** (whether the phone's location permission is on; anything but `off`, or no header, is `on`: the watch and older apps). **`on`**: the server does nothing about location; the phone sends its own place (`PUT /profile/location`, section 7). **`off`**: the IP address is the source of the user's place ([server.md](server.md) section 7, rule 4), even if the last place came from the GPS, and the phone also sends **`X-Ipref`**, the latest `ipref` it was given.

- **The `ipref`** is a time (seconds) and a keyed hash (HMAC-SHA256, the first 32 hex characters) of the IP address and that time, `1731480000.9f2c…`; the address itself is never stored or logged. The server hashes the request's address with the time in the `X-Ipref` it received: **same hash**, nothing; **different hash and the `ipref` over 24 hours old (or missing, or not one of ours)**, the address changed: the place is looked up and saved (`userinfo`: `iso`, `city`, `state`, `lat`, `lon`, `geo_source = 1`, only if the place really is different), and a **new `ipref` is sent back**; **different hash within 24 hours**, ignored.
- **Every answer to an `off` request carries the `ipref` to keep, as the response header `ipref`**: a new one after a lookup, else the one that was sent. The phone keeps the latest and sends it back; when the user turns location off, the phone drops the one it holds, so the next request makes one lookup. An answer to an `on` request has none.
- **The lookup:** the local MaxMind GeoLite2-City database (read into memory once) first; the MaxMind web service when the database has no answer. A private or loopback address is never looked up. **A failed lookup blocks nothing and changes nothing** (the place stays as it was, never 0, 0); the new `ipref` still goes out, so it is tried again after a day (or if the address changes by then). It runs inside the request, but only when the address changed.
- **The address** is the connection's, or `X-Forwarded-For` behind a load balancer (`TRUST_PROXY`, see the production checklist).
- The device's region goes with the sign-in as `deviceInfo.region` (section 1d): the first guess for the country when the first lookup fails.

## 1d. The device data

What the server keeps about each install (`downloads`, [schema.pg.md](schema.pg.md) section 4). The phone says it in **`deviceInfo`** of `POST /auth/login` (and the dev login), and again with **`PUT /device`** (phone token only, 204) when something changed:

| Field | Column | Notes |
|---|---|---|
| `os` | `device_os` (10) | the system version ("17.4") |
| `appVersion` | `appversion` (10) | "1.4.0" |
| `model` | `device_model` (100) | the family, "iPhone" (not the marketing name) |
| `code` | `device_code` (100) | the machine identifier, "iPhone16,1" |
| `manufacturer` | `device_manufacturer` (100) | "Apple" |
| `timezone` | `timezone` | an IANA name |
| `fcmToken` | `fcm_token` | the push token, when the phone has one (only with notifications allowed: [phone.md](phone.md) section 9d1). **`null` takes it away** (the user turned notifications off); an empty text or none keeps what is stored. |
| `region` | (not stored) | 2 letters; the first guess for `iso` when the IP lookup finds nothing |

Everything is optional; a text longer than its column is **cut, not refused**; an empty one is nothing; **a field the request does not carry keeps what the row had**. Every sign-in and every `PUT /device` also sets `last_access_date`. `PUT /device` changes only the caller's own phone install (a watch's row, or someone else's, is never changed).

**The install's first call: `POST /phone/v3/download`** (public: no token; limited per address like the sign-in). **Whenever the app is installed and first opened, signed in or not**, the phone sends `{ downloadid, deviceid, platform?, deviceInfo? }` (its Keychain's download id and device id, section 1d's device data) and the server **makes the install's `downloads` row** with no owner (`userid` empty), the device id, the device data and the place of the request's IP address. **It answers at once, as the first payload, `{ downloadid, place }`**, where `place` is `{ iso, city, state, country, lat, lon }` (`lat` and `lon` only when this very call looked them up) or `null` when the server knows none. The phone keeps it, so it knows where it is before anyone signs in and before location is allowed. A repeat (the app opened again before signing in, or the first call lost) brings the row up to date and answers the same place; the place is found **once**. **The watch is the same: `POST /wearable/v3/download`** makes the watch's own row (`device_type = watch`, `watchos` or `wearos`), with its own download id and device id, also public.

**Signing in then sets the owner of that row**: the login (`downloadid`, `deviceid`) updates the same row with the `userid` (and makes the row if the install never called, or the call was lost). A call with no owner never clears an owner.

**`POST /phone/v3/auth/watch-token`** (the phone's token; body `{ deviceid, downloadid?, device?, platform?, deviceInfo? }` for the watch): the phone gives the watch its **own** tokens ([watch.md](watch.md) section 2). **The moment the watch's tokens are made, its `downloads` row gets the user's id** (the row is made here if the watch never called in), and the phone's row gets `is_watch_paired = true`. Answers `{ accessToken, refreshToken, userid, downloadid }`. The watch's device id **must not be the phone's** (a token row is one per device id: the same id would sign the phone out): 400. The phone's own tokens are never copied to the watch. Only a phone token may call it.

**The first-download place** ([server.md](server.md) section 7, rule 1): while an install's row has no `iso`, the first call (or the sign-in, or the next `PUT /device`) looks up the request's IP address (the local database, then the web service) and stores `iso`, `city` and `state` in the row; if there is no answer, `region` is the first guess for `iso`. It is **found once and never changed after**: the user's place is `userinfo`'s. **A new profile** (the first `PUT /profile`) starts with the place of its own IP address (`geo_source = 1`, with coordinates), else the place of the user's latest phone install; the phone's own place (`PUT /profile/location`) replaces it.

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

File bytes never go through the API. For each file (**built, v3**):

1. `POST /media/:activityid/presign` with `{ "role": "photo" | "video" | "poster", "contentType": "image/webp", "bytes": 312345 }`.
   The server checks that the activity is the user's and not deleted (`tosend > 0`; else 404), that the content type suits the role (a photo or poster is `image/webp` or `image/jpeg`, a video `video/mp4`; else 400 `BAD_MEDIA`) and that `bytes` is within the hard cap (photo 5 MB, video 40 MB, poster 2 MB; the phone prepares to much smaller targets, section "Preparing media" of [phone.md](phone.md)).
   It chooses the name (`<uuid>.<ext>`) and answers `{ "value": "6f1c…2e.webp", "url": "<pre-signed PUT address>", "headers": { "Content-Type": "image/webp" } }`. The address is valid for 15 minutes and is signed for this exact key, **content type and length**: a PUT with another type or size is refused by S3 (`SignatureDoesNotMatch`). The phone sends the `headers` as given; the length is the file's own.
2. The app uploads the file with `PUT url`.
3. `POST /media/:activityid/commit` with `{ "value": "…", "type": "photo" | "video", "dimension": [w, h], "duration": 12.4, "poster": "<poster value>", "blur": "<96 hex digits>" }`. `blur` is optional (photos and posters): a 4 x 4 grid of colours, 6 hex digits each, made on the phone ([phone.md](phone.md) section 8c); the server only checks its shape (`^[0-9a-f]{96}$`) and stores it in the item, so a card can paint a soft stand-in while the picture loads.
   The server checks the owner and `tosend > 0` (404), that the file (and the poster) exists, is within the cap and has the right content type (a `HEAD`; else 400 `BAD_MEDIA` and **the uploaded files are deleted**), that a video has its poster and a photo has none (400), and appends the item to `media_v2` in one statement. It answers `{ "media_v2": [ … ] }`, **the activity's whole list after the change**, which the phone takes as the truth.
   An activity may have **20** photos and videos: the 21st is **409 `MEDIA_LIMIT`** and its files are deleted. A **repeat of the same commit** (the answer was lost) changes nothing and answers the same list.
   It never converts or reads the picture.

A **video's poster** is uploaded first (steps 1 and 2 with role `poster`) and is **not committed on its own**: the video's commit carries its `poster` value. The activity must already be on the server. Media is uploaded one file at a time, in order, so the list keeps its order. A file uploaded but never committed (the phone was killed between the two) is an orphan: it is removed by the next removal of that value, or when the activity is deleted.

### Removing a file

`DELETE /media/:activityid/:value` (phone): takes the item out of `media_v2` (and the name out of an old row's `media` list) in one statement, then deletes the file and, for a video, its poster from S3. **204**; the activity must be the user's (404). **Idempotent**: a value that is not in the list is still 204, and its file is still deleted (it may be an upload that was never committed). The files go after the row is changed: a failed S3 delete leaves an orphan (logged), never a broken activity.

**Deleting an activity** deletes every file under `activitees/<activityid>/` ([server.md](server.md) section 4); a failed S3 delete never fails the delete, and a repeat delete tries again.

The old `POST /media/:actid` (multipart, converts on the server) stays for older app versions and is not used by the new format.

### Reading a file

`GET /media/:activityid/:value` (phone) answers **302** to a pre-signed S3 address of `<activityid>/<value>` in the `activitees` bucket, valid for 15 minutes. The bytes never go through the API and the bucket stays private. `value` is a file name as in `media_v2` (`<uuid>.webp`) or an old row's `media` list, with no slash (400 otherwise).

- **Who:** the owner always; anyone signed in when the owner's profile is shown (`hideprofile = false`). A deleted activity, a hidden profile (for others) and an unknown activity are all 404, so nothing is revealed about which exist. The file itself is not checked: a missing one is S3's own 404.
- **The path is the cache key.** The phone loads `https://…/phone/v3/media/<activityid>/<value>` and its image cache keeps the picture under that address, so the signature that changes on each redirect never defeats the cache. The redirect itself may be kept 10 minutes (`Cache-Control: private, max-age=600`); the files never change under the same name.
- **The token:** `Authorization: Bearer …`, or the same token as `X-Access-Token` (this route only). The phone's image loader follows the redirect itself and on some platforms keeps `Authorization` when it does, and S3 refuses a request with two kinds of authentication; it ignores `X-Access-Token`. **The phone sends only `X-Access-Token`.**
- Local development uses MinIO ([dev-s3/README.md](dev-s3/README.md)); production sets only `S3_REGION` and signs with the server's role.

## 7. Profile and location

| Endpoint | Does |
|---|---|
| `GET /profile` | Returns `{ "profile": { … }, "account": { "email", "loginused" } }`: the user's `userinfo` row without `geom`, `store_id`, `mailids` and `deleted_date`, and the e-mail and login method from `userlogin`. `profile` has `fname`, `lname`, `about`, `gender`, `dobglobal`, `height`, `weight`, `hideprofile`, `timezone`, `iso`, `city`, `state`, `lat`, `lon`, `profilepic`, `profilebg`, `dateregistered`, `last_access_date`, `geo_source`, and **`country`**, the name of the country of `iso` from the server's list (`null` with no place, or a code that is not in the list). **404 `NOT_FOUND` when the user has no `userinfo` row yet: the app reads that as a new user** and goes to the setup steps. Phone only (the watch never reads the profile). Built in v3. |
| `PUT /profile` | Body: any of `fname` (1 to 50 characters), `lname`, `about` (up to 500), `gender` (`male`, `female`, `other`), `dobglobal` (the birth date as midnight UTC, epoch seconds), `height` (cm, 30 to 300), `weight` (kg, 10 to 500); at least one. `null` clears a field (`lname`, `about`, `gender`, `dobglobal`, `height`, `weight`; not `fname`), an empty text clears too, and a text is trimmed. **The first call makes the profile** (`dateregistered` is then, and the row's `store_id`, the account token the app puts on its purchases, section 15), so a new user's setup is this call; later calls change only the fields they carry (last write wins) and never the registration date or the visibility. Answers the fields as saved. An unknown field is ignored (visibility has [its own call](#7c-profile-visibility-public-or-private)); a value out of range is 400. Phone only. Built in v3. |
| `PUT /profile/location` | `{ lat, lon, city, state?, iso }` from the phone's GPS. Exact coordinates (stored as doubles in `geom`; the `lat` and `lon` columns are REAL). Sets `geo_source = 2`. Answers `{ lat, lon, city, state, iso, country }` as saved. **The country's name is not sent and not stored: the server looks it up from `iso` in its own list** (250 entries, `services/location/countries.ts`). `iso` is checked against that list and stored upper case. `lat` in -90 to 90, `lon` in -180 to 180, `city` 1 to 100 characters (cut to 50 for the column), `state` optional (empty means none, `NULL`). **(0, 0) is refused**: it is what a failed fix looks like. Refused: 400 `BAD_REQUEST`. **404 `NOT_FOUND` while the user has no profile row yet** (the setup steps are not saved): the phone keeps the fix and sends it again after the profile. Phone only. Built in v3. |
| `POST /profile/media/presign`, `POST /profile/media/commit` | The profile picture and the cover, same steps as section 6 (`role`: `profilepic` or `profilebg`, bucket `fitpy`). |

Two headers on requests, and one on responses, for the location ([server.md](server.md) section 7):
- `X-Location: on | off` (request): whether location permission is granted.
- `X-Ipref: <value>` (request): the last `ipref` the app received.
- `ipref` (response): the value to send back next time.

## 7c. Profile visibility (public or private)

| Call | What it does |
|---|---|
| `PUT /profile/visibility` | Body `{ hidden: boolean }`; `true` is private (`userinfo.hideprofile`). Answers `{ hidden }` as saved. A repeat changes nothing. **404 `NOT_FOUND` while the user has no profile row yet**: the phone keeps the choice and sends it again after the profile. Phone only. |

A private user's activities and posts are **not in the feed**, their feed activity is 404 for others ([section 11](#11-the-feed)), and so is their profile ([section 14](#14-other-peoples-profiles)); they always see their own. All of these read `hideprofile` on each request, so there is nothing to clean up when it changes, and a user who goes public again is back at once. Photos and videos already served to others are not recalled (a signed address lives a few minutes).

## 7b. Profile picture and cover

One file each, in the `fitpy` bucket under `<uuid>.<ext>`; the name is kept in `userinfo.profilepic` (the picture, kind `pic`) and `userinfo.profilebg` (the cover, kind `bg`) and comes back in `GET /profile` (`profile.profilepic`, `profile.profilebg`). The same three steps as the activity media (section 6), and a reset (**built, v3**):

1. `POST /profile/image/presign` with `{ "kind": "pic" | "bg", "contentType": "image/webp", "bytes": 48213 }` answers `{ value, url, headers }`: the server names the file, and the address is valid for 15 minutes, signed for exactly this key, content type and length. Hard caps: **picture 1 MB, cover 3 MB**; `image/webp` or `image/jpeg` only (400 `BAD_MEDIA`). 404 when the user has no profile yet (the new-user setup saves it first).
2. `PUT url` the file.
3. `POST /profile/image/commit` with `{ "kind", "value" }`: the server checks the file is there with the right size and type (a `HEAD`; else 400 `BAD_MEDIA` and the file is deleted), sets the column in **one statement that also reads the old name**, then **deletes the old file** (a failed S3 delete is logged and leaves an orphan, never a broken profile). Answers `{ "value": "…" }`. A repeat of the same commit changes and deletes nothing.
4. `DELETE /profile/image/:kind` goes back to no image: the column is set to NULL and the old file deleted. **204**, also when there was none (idempotent). 404 without a profile.

**Reading:** `GET /profilepic/:userid/:value` and `GET /profilebg/:userid/:value` answer a **302** to a 15-minute signed S3 address, like the activity media. `value` must be **what that user has set now**, so the route cannot be used to read any other file in the bucket (an old name is 404). The owner always; others only when the profile is shown (`hideprofile = false`); else 404. The address holds the file's own name, so a new picture is a new address and the phone's image cache never shows the old one. The token may come as `X-Access-Token` ([section 6](#reading-a-file), the same reason). The feed's `author` carries `profilepic` (the name) so the phone can load it.

## 8. Delete the account

Built in v3 as the three calls of [section 8b](#8b-deleting-the-account-with-an-e-mailed-code). It needs a connection and is never queued. What happens: [server.md](server.md) section 8, [phone.md](phone.md) section 10.

## 8b. Deleting the account, with an e-mailed code

| Call | What it does |
|---|---|
| `POST /account/delete-code` | E-mails a 6-digit code to the address the account has (`userlogin.email`, from the sign-in; **never one the app says**) through the SNS topic (`SNS_ARN`) that the old API's e-mail also uses. Answers `{ expiresIn: 600, resendIn: 30 }`. Only a keyed hash of the code is stored (`account_deletion_codes`, one row per user); it lives **10 minutes**, dies after **5 wrong tries**, and a new one may be asked for after **30 seconds** and at most **5 an hour** (429 otherwise). 400 for an account with no e-mail address, 503 `EMAIL_UNAVAILABLE` when e-mail is not set up or SNS does not take it. With `DEV_LOGIN=true` and no `SNS_ARN` the code is written to the server's log instead (local testing only). |
| `POST /account/delete-code/verify` | Body `{ code }`. 204 when it is right (it stays valid for the deletion); 400 `DELETE_CODE_WRONG` when it is wrong, expired or used up (a wrong try is counted). The app checks the code as it is typed. |
| `DELETE /account` | Body `{ code }`. Checks the code again, then deletes in this order: (1) the user is marked deleted and hidden; (2) **every file in S3**: the folder of every activity and every post (`<id>/`, with their photos, videos and posters) and the profile picture and cover (a picture that is an `https` address of the old app is not a file and is skipped); (3) **Apple** is told to revoke the Sign in with Apple grant of every device (a failure is logged and does not stop the deletion); (4) **the rows, in one transaction**: the login, which takes the activities, posts, tokens, steps and streak with it (every device is signed out at once), the install rows (an install's row is **shared by whoever signed in on that phone**, so one that another account's activities still point at is left: it holds a device and an app version, nothing about the user), and the profile row. 204. |

**If S3 does not answer, the request fails (502 `DELETE_FAILED`) and nothing after that step is done**: the account still works, and the same request carries on (the code stays valid until its time is up). No file is ever left without an owner, and no row is deleted while its files are still there.

**A user who has bought a subscription keeps their profile row** (`userinfo`: the billing needs it): it is marked deleted (`deleted_date`), hidden, and its picture and cover are cleared; everything else goes. The test is a row in the old app's `paymentstore` ([production-checklist.md](production-checklist.md)). A kept row is never shown to anyone (profile and feed are 404 for it), and signing in with the same Apple or Google account later makes a **new** account.

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

**`POST /sync` carries both of these in one request** (`up.walk = { history?, today? }`, [sync.md](sync.md)); **the phone now sends them that way** (the two routes below are no longer called by the app and stay for old versions).

| Endpoint | Does |
|---|---|
| `PUT /walk/today` | Today's plain columns (**no floors down**), sent when they change: `{ dtgraph, stepcount, distance, ascend, max_steps, max_steps_date, max_distance, max_distance_date, steps_goal, yesterday? }`, where `yesterday` is `{ dtgraph, stepcount, distance }` for the day before (`dtgraph - 86400`), sent whenever the phone has a row for it, for yesterday's leaderboard. A few hundred bytes. Answers 204, or 400 `BAD_DTGRAPH` / `BAD_YESTERDAY` ([server.md](server.md) section 11). **Built.** |
| `PUT /walk/history` | The arrays of the completed days (gzip allowed): `{ base, dtgraph_json, stepcount_json, ascend_json, distance_json, iso_json }`, where `base` is the day the deltas were encoded against. **No `descend_json`, no coordinates.** Sent when a completed day is new or changed. 204, or 400 `BAD_HISTORY` (the arrays do not line up, or `base` is not a day). With no row yet, the server makes one. **Built** (`tests/routes/walk.test.ts`). |
| `GET /walk` | The user's row: the plain columns, the arrays and `history_base`. Used on a restore. |

`dtgraph` is a date label, not a moment ([README](README.md) section 5). What the server does: [server.md](server.md) section 11. What the phone does: [phone.md](phone.md) section 11. The formats: [format.md](format.md) section 5.

## 11. The feed

`GET /feed?limit=20&before=<cursor>` (phone only) answers `{ posts: [{ kind, author, activity | post }], next }`: a page (`limit` 1 to 50, 20 by default) of the **most recent activities and posts ([section 12](#12-posts)) of users who show their profile** (one user can have several), newest first by `enddate` (then `activityid`). A deleted activity (`tosend = 0`) is not in it. Hidden profiles (`hideprofile`) and users without a profile are not in it. (Earlier it was ordered by the time on the clock where it happened. `enddate` is the same order for nearly everyone and is served by an index, `activities_feed`, [schema.pg.md](schema.pg.md) section 2.)

- **Two kinds of item.** `kind` is `activity` (with `activity`) or `post` (with `post`: `{ postid, posted_at, content, media_v2 }`, section 12). They are merged by time, `enddate` for an activity and `posted_at` for a post; the cursor `<time>.<id>` works for both (ids are random UUIDs, so they never clash). A post with nothing to show yet (made, but no file uploaded and no words) is not in the feed. The index `posts_feed` serves the post side.
- **A small post.** `activity` is the **summary only**: the small columns, `media_v2`, the description and **`route_preview`** (the route in about 120 points, [format.md](format.md) section 6). It has **no track, no heart rate and no `activitydetail_v2` beyond what a card needs**, so a page is a few KB, not hundreds. It never contains a `userid`. The phone draws the card from it and works the numbers (pace, calories) out itself.
- **Paging:** `next` is a keyset cursor `<enddate>.<activityid>`, or `null` at the end. Pass it back as `before`. A page never shifts when something new arrives, and equal times cannot be skipped. A bad cursor or `limit` is a 400. **There is no limit per user for now; one is to be added for production.**
- **ETag.** The first page (no `before`) carries an `ETag` made from what it holds; a request with `If-None-Match` of the same value is answered **304** with no body. The phone sends it with every refresh, so a feed that has not changed costs a few bytes.
- `author` is `{ userid, fname, lname, weight, profilepic, city, state, iso, country }`. `country` is the name of `iso`. `weight` is the author's, so the phone can estimate calories. `profilepic` is the file name; the picture is read at `/profilepic/:userid/:value` (section 7b).
- Built in SQL and joined by string, so nothing large is parsed in Node. Read from the reader. Compressed on the wire.

### One whole activity: `GET /feed/:activityid`

Opening a feed card's map lands on the **Activity details** screen, which needs the whole activity (the track, heart rate, elevation). This asks for it: the same row as a restore (section 4) plus the `author`, so the phone unpacks it with the code it has for its own activities. The owner always gets their own; anyone else only while the owner shows their profile, else **404** (the same answer as a deleted activity, so it does not reveal that it exists). The screen draws at once from the preview and **fills in the charts when this arrives** (it never waits); an error is shown in a toast.

### Rate limit and media

The other routes are limited per IP. **The image routes** (`/media/...` read, `/profilepic/...`, `/profilecover/...`) are limited **per token, 600 a minute**, because a feed shows many photos at once. There is no CDN for now.

### On the phone

The feed is **stored in SQLite** (`feed.db`) and read back through a reactive query ([phone.md](phone.md) section 8c). The phone asks for the first page (with the ETag) **when the app starts, when it comes to the front, when someone signs in, and on pull to refresh**: there is no timer, and showing the tab again asks for nothing. It asks for the next page as the user scrolls near the end.

## 12. Posts

What the user shares from Home: a **template** (the day's steps, distance, or both), **photos and videos**, and **words** (a title and a description). A post has an id made on the phone, so a repeat of any call changes nothing. Shape of `content`: [format.md](format.md) section 7. Table: [schema.pg.md](schema.pg.md) section 11.

| Call | What it does |
|---|---|
| `PUT /posts/:postid` | Body `{ posted_at, content, media? }`. Makes the post, or changes what it says (its time and media are not changed). Answers `{ status: "created" \| "exists" \| "deleted", media_v2 }`. A post that was deleted answers `deleted` and is not brought back. An id that is another user's is 404. |
| `DELETE /posts/:postid` | 204. The row stays as a marker (`tosend = 0`, what it said and its media list emptied) and every file under `<postid>/` in S3 goes. A repeat is 204; an unknown id is 404 (the app treats it as done). |
| `GET /posts?limit=50&before=<cursor>` | The user's own live posts, newest first, `{ posts: [{ postid, posted_at, content, media_v2 }], next }`; cursor `<posted_at>.<postid>`. For a restore. |
| the media routes | `presign`, `commit`, `DELETE` and the read `GET /media/:id/:value` of [section 6](#6-media-a-pre-signed-upload) take the id of an **activity or a post** (the server finds which). A post may have 20 photos and videos, like an activity. Files are in the same bucket, under `<postid>/`. A post's media is read by others unless its owner hides their profile. |

**The rule.** A post needs **photos or videos coming, a title or a description**. A template alone is refused (400 `BAD_POST`), and so is a template without the numbers it shows (`steps` needs `steps`, `distance` needs `distance`, `steps_distance` needs both). A post may have **no template** (words only). `media` is how many files the phone is about to upload after the PUT; it is not stored, it only allows a post with no words (the files come one at a time and the post exists first).

**The `content` is checked here and stored as it is** (title up to 120 characters, description up to 2000, `steps` and `distance` whole numbers, an unknown field or template is refused 400), and the server never reads inside it afterwards. Adding a field is a line in the schema, not a migration.

**Order of work on the phone:** `PUT` the post, then its files (presign, PUT, commit each, in order), so the post exists before a file is added. A failed or killed upload resumes next time ([phone.md](phone.md) section 8d).

## 13. Weather

The conditions at a point, so an activity can carry the weather it was done in. The phone asks at the **start** of an outdoor activity (or at the end when it was offline) and keeps the answer with the activity; nothing is worked out on the server and nothing is stored there by this route. The keys of the providers are set in the server's environment (`WEATHER_API`, `OPEN_WEATHER_API`, [server.md](server.md) section 13) and never leave it.

| Call | What it does |
|---|---|
| `POST /weather` | Body `{ lat, lon }` (degrees, `lat` -90..90, `lon` -180..180). Answers `{ uvi, temp, feels_like, humidity, wind_speed, weather_icon, weather_description, aqi }`. |

- **Units are the ones the activity stores:** `temp` and `feels_like` in **kelvin** (whole numbers), `wind_speed` in **km/h**, `humidity` in %, `uvi` as the UV index, `aqi` 1 (good) to 5 (very poor).
- `weather_icon` is an OpenWeather icon name (`01d`, `10n`...); `weather_description` is the text to show.
- **Two providers, in order:** WeatherAPI first (the condition code gives the text and the icon, the PM2.5 gives `aqi`), OpenWeather (`onecall` and `air_pollution`) when it fails or gives no answer within 6 seconds. OpenWeather's wind is in m/s, so it is converted.
- **Errors:** `502 WEATHER_UNAVAILABLE` when both fail, `503 WEATHER_UNAVAILABLE` when no key is set. The phone keeps the activity as it is and asks again later; a refusal is never a reason to lose or hide the activity.

## 14. Other people's profiles

What the User screen shows (opened from a name on a feed card, or from Settings for your own). Any signed-in user may read these. A profile that is hidden (`hideprofile`), a deleted account and an unknown id are all **404**, except for its owner, who always reads their own; nothing says which exist. There is no follow, followers count or "similar people" yet.

| Call | What it does |
|---|---|
| `GET /users/:userid` | `{ user, counts, totals, monthly, bests }`. `user`: `userid, fname, lname, about, profilepic, profilebg, city, state, iso, country, dateregistered` (the pictures are read with `GET /profilepic/:userid/:value` and `/profilebg/...`, [section 7b](#7b-profile-picture-and-cover)). `counts`: `{ activities, photos }` (the photos and videos of their activities and posts). `totals`: `{ distance (m), duration (s) }` all time. `monthly`: up to 36 rows `{ ym "YYYY-MM", n, distance, duration }`, newest first, only months with activities; a month is in the user's own time zone (`seconds_from_gmt`). `bests`: `{ longest_distance (m), longest_duration (s), fastest_sec_per_km }`, each `null` when they have none; the fastest pace counts only activities of 1 km or more. |
| `GET /users/:userid/feed?limit=20&before=<cursor>&kind=&media=` | A page of **their** activities and posts in exactly the shape and order of [the feed](#11-the-feed) (`{ posts: [{ kind, author, activity \| post }], next }`, newest first by end time, cursor `<time>.<id>`). `kind=activity` or `kind=post` keeps one; `media=true` keeps only those with photos or videos (the Photos tab). Deleted ones are never listed. |

The server only adds up rows it stores. **The phone works out every figure shown** ([phone.md](phone.md) section 8e): this month, this year and all time, the bars (the last twelve months, or the last twelve quarters for all time), and how the bests read. Photos and videos of others are read with the media routes ([section 6](#6-media-a-pre-signed-upload)) as in the feed.

## 15. The store and the Pro state

What the user has (Pro, invite codes, bought protection days) and what is on sale, in **one call**, asked once at the start and after sign-in (not on every screen); a purchase or a redeem answers with the same `entitlement` object. The rules for what a purchase does are the old app's, and the tables are the old app's too (`membership`, `protection_logs`: the v2 API keeps writing them), so they are read as they are. **Built: the Pro state, and for iOS the purchase and the App Store's notification, and redeem. Not yet: Android** ([production-checklist.md](production-checklist.md) section 4).

| Call | What it does |
|---|---|
| `POST /purchases/ios` | Phone only. Body `{ signedTransaction }`: the transaction **exactly as the App Store signed it** (`verificationResultIOS`, a JWS). Checked, recorded, granted; answers `{ purchase: { id, productId, kind, alert }, entitlement, protection: { grants } }` (the new state, read from the writer so what was just granted is in it). `purchase.id` is the payment row's id, the same for every report of the same purchase. 400 `PURCHASE_REFUSED` when the value is not signed by the App Store for this app, or the product is not on the list (it is then **recorded** but grants nothing, so it can be looked at); 503 `STORE_UNAVAILABLE` when production purchases are not set up (`APPLE_APP_ID`): the phone keeps the purchase and sends it again later. |
| `POST /redeem` | Phone only. Body `{ code }`: an invite code as typed or linked (any case, with or without the dash, spaces ignored). Answers `{ redeemed: { id, productId, alert, referrerStoreId }, entitlement }` (`referrerStoreId` is the buyer's account token, for the phone's analytics). **The claim is one update that only succeeds while nobody has redeemed the code**, so two people cannot both get it; a lock on the user keeps one person from redeeming two codes at once. Errors: 404 `CODE_INVALID` (no such code, or not a code), 409 `CODE_USED` (`message`: "This code has been redeemed", or "You have redeemed this code"), 409 `ALREADY_PRO`, 400 `CODE_EXPIRED`. A code of a lifetime pack gives a lifetime (its `product_id` has `lifetime` in it); any other follows the end of the buyer's plan (its own row with the same `reference_id`), and is expired when that has ended or there is none. Which table: `BILLING_ENV`, never the app. **10 tries a minute per token** (429 after), so codes cannot be guessed. |
| `POST /store/v3/appstore` | **Not signed in:** the App Store's own signature is the proof. Body `{ signedPayload }` (App Store Server Notifications v2). Checked, kept in `receiptdump`, and applied the same way as the phone's report, so a purchase counts even if the phone never reported it. 200 when done; 400 when the signature does not check out (the App Store then sends it again). |
| `GET /me/state?catalog=<version>&ads=<version>&platform=ios\|android` | Phone only. `{ accountToken, entitlement, protection: { grants }, catalog, ads }`. **`accountToken`** is the user's `userinfo.store_id`: **the app puts it on every purchase** (Apple's `appAccountToken`) so the App Store's notification can say whose a purchase is even when the phone never reported it. A new profile gets one when it is made; a profile from before that has none and is given one by this call, once (the same afterwards); `null` while there is no profile row yet. `catalog` is the whole catalogue when the phone's `?catalog` is missing or not the current version, else just `{ version }` (the phone keeps the one it has). **`ads`** is the ad rules for the phone's `platform` (`ios` when not said; anything else is 400): whole when `?ads` is missing or not the current version, else just `{ version }`. The rules are plain data in the server's code (`src/services/ads/adsData.ts`, checked when the server starts, `platforms` laying one platform's changes over the rest) and say nothing about one user: `enabled` (kill switch), `rolloutPercent`, `graceDays` (no ads for a new account), `quietHoursAfterPurchase`, `fullScreen: { minGapSeconds, maxPerSession }`, `events` (`app_open`, `activity_recorded`: `enabled`, `format`, `maxPerDay`, `cooldownSeconds`) and `placements` (`home_inline`, `feed_inline`, `activity_detail_inline`, `navigation_banner`: `enabled`, `formats`, `every`). **The phone decides** ([phone.md](phone.md) section 9f); Pro is not in the rules. A `version` is 12 hex characters; anything else is 400. |

**`entitlement`**: `{ pro, source, productId, lifetime, expiresAt, codes }`. `pro` is true when the user has a membership that has not ended: their **own** (`buyer_userid` with no `invite_code`: a plan, or the buyer's seat of a pack) or one they **redeemed** (`source`: `own` or `gifted`; `null` when not Pro). `lifetime` is true when it never ends, and `expiresAt` (epoch seconds) is then `null`. `codes` are the invite codes of the packs the user bought: `{ code, createdAt, sharedAt?, activatedAt?, firstName?, lastName? }` (the last three once someone redeemed it), oldest first. All times are epoch **seconds**.

**One definition of "still valid".** `membership.expires_date` is in milliseconds where the iOS code wrote it (9999999999999 for a lifetime) and in seconds where the Android code did (9999999999). Anything above 1e11 is read as milliseconds, so both count the same, and an iOS plan that has ended is no longer Pro (compared raw, a millisecond value never expired). What v3 writes itself will be in seconds. The code is `services/store/membershipSql.ts`.

**`protection.grants`**: `[{ id, days, at }]`, the protection days the user **bought** (a `protection_logs` row of type `iap` with no streak; days spent are not listed). The phone applies each `id` once, so a day is never counted twice and never lost because the pop-up was not seen.

**`catalog`**: `{ version, subscription, streak }`, built from plain data in the server's code (`services/store/catalogData.ts`, the old payload's shape), so a new pack, a changed text or a plan put on sale is a change of that file and a deploy, and no app release. **It is not in a table for now.** An option can be taken off sale with `active: false` (a purchase made earlier is still recognised). Each section has `primaryTitle`, `secondaryTitle`, `subtitle`, `howItWorks`, `communication` and `options`; `subscription` also has `mode`: `lifetime` (one-time packs) or `subscription` (a product of kind `subscription` is on sale). An option has `id` (its position), `productId`, `kind` (`subscription`, `groups` or `streak`: what a purchase does), `billingType` (`consumable`, `one-time` or `subscription`: how the store treats it), `membership` (seats of a pack) or `frequency` (protection days), and its texts (`title`, `description` and `descriptionAlt` with `--` for the per-member price, `buyButton`, `buyDescription` with `--` for the price, `tagText`, `isBigCard`, `icon`, `alert`). **There are no prices:** the phone gets them from the store and fills the `--`. The server builds it once at the start. `version` is a hash of the content.

**Which tables:** `BILLING_ENV` is `production` (the default: `membership`), `sandbox` (`membership_sandbox`) or `both` (a server that also serves TestFlight and App Review). It is the server's own setting, never the app's.

**What a purchase does** (one function, `services/store/grantPurchase.ts`, for the phone's call **and** the notification; safe to run any number of times for the same purchase, with a lock on the original transaction so two at the same moment make the codes once). The rows are the old app's, in the live tables or the `_sandbox` copies **by the environment inside the checked data, never by anything the app sends**:
- the **payment**: `payments` (a row per `transaction_id`, written as the old code wrote it: `amount` is Apple's own number, in thousandths of the currency; `convert_rate` is the units of the currency per US dollar from a free currency list, 2 decimals, as the old code did (`services/store/exchangeRate.ts`: kept 6 hours, fetched before the purchase's transaction starts, and **1 when the list cannot be reached**, for dollars or for a currency not on it, so a purchase is never held up); a renewal updates the end and the renewal fields);
- `kind: streak`: a `protection_logs` row of type `iap`, once per `transaction_id`;
- `kind: subscription`: one `membership` row for the buyer's own plan whatever its renewals (the end moves; written in **seconds**);
- `kind: groups`: as many `membership` rows as the pack holds, one invite code each (`ABCD-EFGH`, from a secure random source). **The first is redeemed for the buyer** when they are not Pro yet and hold no code of this pack; a repeat makes only the codes still missing.

**How the check works** (`services/store/apple/verifier.ts`): the signed value's certificate chain must lead to Apple's root (the public roots are in `certs/apple`), and it must be for this app (`APPLE_CLIENT_ID`, the bundle id; and for production `APPLE_APP_ID`, the numeric App Store id) and for the environment it names. The signed value's own `environment` only picks which check to run; the check fails if the claim is false. **A purchase made in Xcode's local StoreKit test environment is signed with a local key and is refused**: test with a sandbox account. **Who the user is:** for the phone's call, the token; for a notification, the user who already has a payment with the same original transaction, else the one whose `userinfo.store_id` is the `appAccountToken` the app put on the purchase (the app must send it). A notification for a user we cannot find is kept in the dump and nothing else. **A refund or revoke is only kept**: nothing is taken back yet.

