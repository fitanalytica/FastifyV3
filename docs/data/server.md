# Server (Postgres and S3)

What the server stores and the rules it applies. The requests: [api.md](api.md). The activity format: [format.md](format.md).
The server is a storage engine: it does no maths on the data and never converts media.

## 1. Schema changes

The tables, indexes, constraints and the migration are in [schema.pg.md](schema.pg.md). In short:
- `activities`: `tosend` means 1 phone has it, 2 watch uploaded and the phone has not acknowledged, 0 deleted; three new columns (`activitydetail_v2`, `activitybpm_v2`,
  `media_v2`); three indexes; a check on `tosend`. `lat` and `lon` keep their `REAL` type.
- `userinfo`: `geo_source`, a nullable `geom`.

Nothing else reads `tosend` with its old meaning (1 = send, 0 = not send); confirm before release.
Every list query (restore, the watch's 50) adds `tosend > 0`, so deleted markers are never returned.

## 2. The write (upsert)

- The server sets `tosend` from the token's device kind, not from the body: phone = 1, watch = 2.
- `downloadid` comes from the body: it is the device that **recorded** the activity (a watch activity uploaded
  by the phone keeps the watch's `downloadid`). The server only checks that this `downloads` row belongs to the
  user. It is never updated on a repeat, like `iswatch`.
- `geom` is built from the request's `lat` and `lon`: `ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)` (longitude first). It holds the exact start point (doubles). When the server sends a new-format row to a device
  (restore, inbox), it returns `ST_Y(geom) AS lat, ST_X(geom) AS lon`, because the compact arrays are relative to that start ([format.md](format.md) section 2).

```sql
INSERT INTO activities (activityid, userid, ..., downloadid, iswatch, tosend, geom, ...)
VALUES (:activityid, :userid, ..., :downloadid, :iswatch, :tosend, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), ...)
ON CONFLICT (activityid) DO UPDATE
   SET tosend      = LEAST(activities.tosend, EXCLUDED.tosend),
       -- the editable columns: applied only while the activity is not deleted (tosend > 0)
       media_v2    = CASE WHEN activities.tosend > 0 THEN EXCLUDED.media_v2    ELSE activities.media_v2    END,
       description = CASE WHEN activities.tosend > 0 THEN EXCLUDED.description ELSE activities.description END
   WHERE activities.userid = EXCLUDED.userid                    -- never touch another user's row
RETURNING activityid, tosend, (xmax = 0) AS inserted;
```

- A repeat of the same activity changes `tosend` and the **editable columns**, `media_v2` and `description` ([phone.md](phone.md) section 5).
  `iswatch`, `downloadid`, the track, the totals and every other column stay as first written.
- No row returned means the id belongs to another user: answer `invalid`. A returned `tosend` of `0` means the
  activity was deleted: answer `deleted`.
- The JSON columns are stored as received. The server never reads inside them (apart from the media list, section 3). A JSON `null` is stored as SQL NULL, and a missing `media_v2` as `[]`.

**How it is written (built, `src/activities/upsert.ts`).** Each item is checked in code first (types, ranges, equal track lengths, the `downloadid` belongs to the user; all the `downloadid`s of a batch in one query). The valid items go to Postgres as **one statement**
(`INSERT ... SELECT FROM jsonb_to_recordset($1) ... ON CONFLICT`), so a batch is one round trip. If that statement fails with a data or integrity error (SQLSTATE class 22 or 23) the items are written one by one to find the culprit, which is answered `rejected`.
Any other error is a 500. Measured locally: 20 activities of 3,600 points (255 KB gzip, random data) in about 100 ms; one activity in about 17 ms.

## 3. Clean-up when the media list changes

When a repeat changes `media_v2` (an item was removed), the server deletes the files under `activitees/<activityid>/` that the new list does not
mention (the `value` and `poster` of every item). The phone's loop sends one request at a time, so a file that is being uploaded is never deleted by mistake.
A file that was uploaded but never committed is removed by the next clean-up of that activity or by its delete.

## 4. Deleting an activity

`DELETE /activities/{activityid}`:
1. Delete every file under `activitees/<activityid>/` in S3 (this also covers old media).
2. Set `tosend = 0` and empty the large columns (`activitydetail_v2`, `activitybpm_v2`, the track arrays, `media_v2`,
   and the old `media`, `media_details`, `activitydetail`, `activitybpm`), keeping the small summary so the row is only a marker.
3. Answer 204. An unknown id answers 404. A failed S3 delete leaves an orphan file for a clean-up job, never a broken activity.

**Built so far (v3):** steps 2 and 3. Step 1 (the S3 files) comes with the media slice, because nothing writes files yet. A repeat delete is 204 and does not rewrite the marker; another user's id is 404.
**Built: removing `activitees/<activityid>/` in S3** after the row is marked (a failed S3 delete is logged and never fails the delete; a repeat delete tries again). Code: `services/media/s3Ops.ts` (`deleteFolder`).

**The marker stops a deleted activity coming back.** The upsert keeps the lower `tosend` (section 2), so an upload of a
deleted id (a watch that uploads late) stays `0` and is answered `deleted`, and that device removes its copy.
A device that missed the delete message keeps a stale copy until it is reinstalled. That is accepted.

## 5. The inbox

```sql
-- GET /activities/inbox
SELECT ... FROM activities WHERE userid = :userid AND tosend = 2 ORDER BY startdate LIMIT :limit;

-- POST /activities/ack
UPDATE activities SET tosend = 1 WHERE activityid = ANY(:ids) AND userid = :userid AND tosend = 2 RETURNING activityid;
```

If the phone uploads a watch activity itself, the upsert's `LEAST` has the same effect as the acknowledgement.

**Built (v3).** Both statements run on the **writer**, not the reader: the phone repeats "fetch, ack" until the inbox is empty, and a lagging reader could hand back an item that was just acknowledged. It is a few rows on the `activities_inbox` partial index, so the writer does not feel it.
The reply is built in SQL (`json_agg`) and sent as JSON **text**: the large arrays are never parsed and re-written in Node. Rows are `ORDER BY startdate, activityid`, and `LIMIT` keeps the oldest.

## 6. Media in S3

| What | Bucket | Key |
|---|---|---|
| Activity media | `activitees` | `<activityid>/<value>` |
| Profile picture, cover | `fitpy` | `<value>` |

- **Reading** is `GET /media/:activityid/:value`: a 302 to a 15 minute pre-signed GET ([api.md](api.md) section 6). The server signs locally and makes no S3 request. Config: `S3_REGION`, `S3_BUCKET_MEDIA` (`activitees`), `S3_BUCKET_PROFILE` (`fitpy`); for a stand-in also `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- **Writing** (`services/media/`: `presign.ts`, `commit.ts`, `removeMedia.ts`, `limits.ts`): see [api.md](api.md) section 6. Caps: photo 5 MB, video 40 MB, poster 2 MB; 20 items per activity; the commit is one `UPDATE` that appends only if the value is not already there and the list is not full.
- **Profile pictures and covers** (`services/media/profileImage.ts`): see [api.md](api.md) section 7b. Caps: picture 1 MB, cover 3 MB. Setting one is a single `UPDATE userinfo … FROM (SELECT … FOR UPDATE)` that returns the old name (a `WITH … RETURNING (SELECT …)` does not: it sees the row after the update), so the old file can be deleted; the column name comes from a fixed table, never from the request.
- The presign step checks the owner, `tosend > 0` and the size cap for the role, and signs a PUT for that exact key, content type and length.
- The commit step checks that the object exists with the right size and type (a `HEAD`), then, in one statement:

```sql
UPDATE activities
   SET media_v2 = COALESCE(media_v2, '[]'::jsonb) || $1::jsonb
 WHERE activityid = $2 AND userid = $3 AND tosend > 0
RETURNING media_v2;
```

  `$1` is `[{ "type": ..., "value": ..., "dimension": [w, h], "duration"?: ..., "poster"?: ... }]`. If no row is updated, the server deletes the file and answers 404.
- For the profile, the commit sets `profilepic` or `profilebg` and deletes the old file, unless the old value starts with `https` (a sign-in provider's picture).
- No `sharp`, no conversion. Caps (proposed): photo about 3 MB, video about 25 MB, poster about 1 MB.

## 7. Location

Two sources, stored in `geo_source`: `1` = IP address, `2` = GPS. There is no manual source.

**Rules**
1. **First download.** The server looks up the IP address (the in-memory database, with the web service as a fallback) and stores `iso`, `city`, `state`, `lat` and `lon`
   with `geo_source = 1`: in `downloads` at first, and in `userinfo` when the user signs up.
2. **A failed lookup never blocks anything.** The location stays unknown (`NULL`, never 0,0). The app sends its device region as `regionHint` on the
   first request and the server uses it for `iso` as a first guess.
3. **Never update until a new location is available.**
4. **Location off means IP tracking.** While location permission is off (not asked, denied, or turned off later), the IP address is the source, even if the last place came from GPS.
   The app tells the server which case with the `X-Location` header. When the user turns it off, the app drops its stored `ipref`, so the next request makes one lookup.
5. **Location on means GPS only.** The server runs no IP lookups while `X-Location: on`. The phone sends its location ([api.md](api.md) section 7, [phone.md](phone.md) section 9).
6. **The watch's location is never used for the profile.** Watch activities still carry their own route.

**Detecting an IP change (`X-Location: off`).** The server never stores an IP address. Every response carries an `ipref`: the time of the last lookup, plus a keyed
hash (HMAC) of the IP address and that time, for example `1731480000.9f2c…`. The app keeps the latest `ipref` and sends it back in `X-Ipref`. The server hashes the
current IP address with the time in the `ipref` and compares:

| What the server sees | What it does |
|---|---|
| Same hash | Same IP. Nothing. |
| Different hash and the `ipref` is over 24 hours old (or missing) | The IP changed. Look up, update by the SQL below, and answer with a new `ipref`. |
| Different hash and the `ipref` is under 24 hours old | Ignore it. |

The app and the logs never hold an address, only the opaque value.

```sql
-- the phone's location (X-Location: on)
UPDATE userinfo
   SET lat = :lat, lon = :lon, city = :city, state = :state, iso = :iso,
       geom = ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), geo_source = 2
 WHERE userid = :userid;

-- the IP lookup (X-Location: off): only if the place really changed
UPDATE userinfo
   SET lat = :lat, lon = :lon, city = :city, state = :state, iso = :iso,
       geom = CASE WHEN :lat IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) END, geo_source = 1
 WHERE userid = :userid
   AND (city, state, iso) IS DISTINCT FROM (:city, :state, :iso);
```

**Built (v3):** the phone's location (`PUT /profile/location`, `services/profile/updateLocation.ts`): the first UPDATE above, with the country code checked against the server's list and stored upper case, `(0, 0)` refused, `city` and `state` cut to their column length, and a 404 while there is no `userinfo` row.
**Country names come from the server's list** (`services/location/countries.ts`, keyed by ISO code), never from the database: the tables keep only the code (`userinfo.iso`, `activities.iso`), and a name is added when a reply goes out (`GET /profile` and the location reply). A code the list does not have gives no name, and is not an error when it is already stored.
**Built (v3): the IP lookup** ([api.md](api.md) section 1c), for a phone that says `X-Location: off`:
- `services/location/ipToGeo.ts`: the **local MaxMind GeoLite2-City database** (`GEOIP_DB_PATH`, opened once and kept in memory: no disk read per request), then the **MaxMind web service** (`MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY`, host `geolite.info`, 3 second timeout) when the database cannot answer. A place needs a country in the server's list; no coordinates (or (0, 0)) are `null`, never 0; a private, loopback or link-local address is never looked up; nothing throws, a failure is `null`.
- `services/location/ipref.ts`: the `ipref` (`<seconds>.<32 hex of HMAC-SHA256(ip|seconds)>`, key `IPREF_KEY`, else derived from the JWT secret) and the check (`same`, `changed`, `ignore`).
- `services/location/ipLocation.ts` + the hook `controller/phone/v3/iplocation.ts` (a `preHandler` of the phone's v3 routes, so after sign-in): for `X-Location: off` it checks the `X-Ipref`, looks up on `changed`, runs the second UPDATE above (`geo_source = 1`, only when `(city, state, iso)` changed), and answers the `ipref` header. A failed lookup never blocks the request.
- The client's address is the socket's, or `X-Forwarded-For` behind a load balancer: set `TRUST_PROXY` (`true`, or the number of proxies) there, or every user would be the load balancer.
- Tests: `tests/services/location/ipToGeo.test.ts`, `ipref.test.ts`, `tests/routes/ip-location.test.ts` (fake sources, so no file or network is needed). Checked once by hand with the real database and the web service (8.8.8.8 → US, 81.2.69.142 → GB/Ipswich, 103.21.58.1 → IN/Mumbai).
**Built (v3), rules 1 and 2:** the install's `downloads` row is made **when the app is first opened, signed in or not** (`POST /phone/v3/download`, `POST /wearable/v3/download`: `services/auth/install.ts`, public, limited per address like the sign-in) with the download id, the device id (`downloads.deviceid`, `dev-db/09-downloads-device-v3.sql`), the device data and the place of the IP address, which is answered at once as the first payload; **the sign-in then sets the row's owner** (`services/auth/downloads.ts`, `registerDownload`: a repeat with no owner never clears one), and **the watch's tokens set the watch row's owner the moment they are made** (`POST /phone/v3/auth/watch-token`, `services/auth/watchToken.ts`). Both are built on one function, `registerDownload`: the row is made with the device data the phone sent ([api.md](api.md) section 1d) and, while it has no `iso`, the **first-download place** from the request's IP address (`iso`, `city`, `state`), found once and never changed after; if the lookup finds nothing the device's `region` is the first guess for `iso` (rule 2). `PUT /device` (`updateDevice`) keeps the row current and looks the place up again if it is still empty. **A new profile** (`putProfile`, the first call) starts with the place of that request's IP address with coordinates (`geo_source = 1`), else the place of the user's latest phone install (no coordinates); the phone's GPS place replaces it. A watch is the same, with its own row and its own place.
**Not built:** mapping the machine identifier (`device_code`, "iPhone16,1") to a marketing name for `device_model`; `total_session_count`, `total_session_duration` and `uninstall_date` of `downloads` (nothing in v3 fills them).

## 8. Deleting an account

**Built** (`services/account/`, [api.md](api.md) section 8b). `POST /account/delete-code` and `/verify` keep a keyed hash of the e-mailed code in `account_deletion_codes` (`dev-db/07-account-deletion-v3.sql`), and `DELETE /account` (the user is from the token, and the code is checked again) does, in this order, so a failure leaves nothing that cannot be repeated:
1. Sets `userinfo.deleted_date` to now and `hideprofile` to true: hidden from everyone at once. **The tokens still work**, so the same request can be repeated.
2. Deletes the files in S3: the folder `<id>/` of **every activity and every post of the user** (not only those with a media list: a file uploaded and never committed is the user's too), sixteen at a time, and the picture and cover in `fitpy` (a value that is not a file name, the old app's `https` address, is skipped). **If S3 fails the request fails (502) and nothing else is deleted.**
3. Revokes the Sign in with Apple grant of every device (`apple_refresh_token`, `revokeAppleToken`: Apple requires it on account deletion). A refusal is logged for a retry by hand and never stops the deletion.
4. In **one transaction**: `DELETE FROM quotations` (where that old table exists; its foreign key has no delete action and would stop the next step), `DELETE FROM userlogin` (cascades to `activities`, `posts`, `usertokens`, `walkdata`, `streak_logs`, the deletion code and the other tables that point at the login: **every device is signed out**), `DELETE FROM downloads` (one install row at a time inside a savepoint: **`downloadid` is the install, not the user, so another account that used the same phone may still have activities pointing at it, and that row is left**), and `DELETE FROM userinfo` **unless the user has a row in `paymentstore`** (a subscription: the row is then kept for billing, with the pictures cleared and hidden). The server forgets the user's cached access tokens so every device is out at once.
5. Answers 204.

The e-mail goes out through `services/email/sendEmail.ts`: a message `{ fromName, from, to, subject, body }` to the SNS topic `SNS_ARN` (region `SNS_REGION`, us-east-1 by default), the same message the old API sends. Locally, with no topic and `DEV_LOGIN=true`, the code is written to the log.

Open (README open item 10): a grace period before the rows go was not built: the deletion is at once.

## 9. Token clean-up

A daily job deletes token rows that have not been used for **365 days**. This removes the old phone's row after an upgrade to another model, and the rows of installs that were never used again.

```sql
DELETE FROM usertokens
 WHERE GREATEST(COALESCE(accessed_date, 0), COALESCE(changed_date, 0)) < (EXTRACT(EPOCH FROM now())::bigint - 31536000);
```

`accessed_date` is only written when it is more than an hour old, and `changed_date` moves on each login and refresh, so an active device is never deleted.
A refresh token has no expiry of its own today, so this is also its longest life.

## 10. Refresh with a long grace period

So that a refresh whose reply is lost never signs the user out, the row keeps the refresh value from before the last rotation (`prev_refresh_token`, `prev_changed_date`) for **30 days in production**, and the window slides. The length is the setting `REFRESH_GRACE_SECONDS` (unset = 30 days; local testing sets `120`, 2 minutes, in `.env.local`). (A reply is lost when the app is killed, crashes or is reloaded between the server rotating and the phone saving the new value; with a short window the user was signed out for no reason of their own.)

1. A refresh finds the row where `refresh_token = :hash` (or the raw old value), or where `prev_refresh_token = :hash AND prev_changed_date > now - 30 days`, and `revoked = FALSE`.
2. It makes new access and refresh values and replaces both. **If the refresh matched the current value**, it also stores the old one: `prev_refresh_token = old refresh_token`, so using the newest value always replaces the previous one.
   **If it matched the previous value** (a retry), it leaves `prev_refresh_token` as it was, so a second lost reply can be retried too, and sets `prev_changed_date = now` (the window slides: each retry moves it on).
3. It returns the new pair. Any other refresh value, or the previous one after the grace without a retry, answers `LOGOUT`.

The cost: a stolen old value works until the real next one is used, or for 30 days at most. A device is still signed out at once by `revoked` (logout, unpairing, account deletion).

## 11. Step history

The `walkdata` row ([schema.pg.md](schema.pg.md) section 10) is stored as received; the server decodes nothing. The user is from the token. `dtgraph` is a date label, not a moment ([README](README.md) section 5).

```sql
-- PUT /walk/today: fixed-size columns only, so the large JSON columns are not rewritten
INSERT INTO walkdata (userid, dtgraph, stepcount, distance, ascend,
                      max_steps, max_steps_date, max_distance, max_distance_date, steps_goal,
                      yesterday_dtgraph, yesterday_stepcount, yesterday_distance, ddate)
VALUES (:userid, :dtgraph, :stepcount, :distance, :ascend, :descend,
        :max_steps, :max_steps_date, :max_distance, :max_distance_date, :steps_goal,
        :yesterday_dtgraph, :yesterday_stepcount, :yesterday_distance, :now)
ON CONFLICT (userid) DO UPDATE
   SET dtgraph = EXCLUDED.dtgraph, stepcount = EXCLUDED.stepcount, distance = EXCLUDED.distance,
       ascend = EXCLUDED.ascend, descend = EXCLUDED.descend,
       max_steps = EXCLUDED.max_steps, max_steps_date = EXCLUDED.max_steps_date,
       max_distance = EXCLUDED.max_distance, max_distance_date = EXCLUDED.max_distance_date,
       steps_goal = EXCLUDED.steps_goal, ddate = EXCLUDED.ddate,
       -- the phone sends yesterday only when it has a row for it: an absent value keeps what is stored
       yesterday_dtgraph   = COALESCE(EXCLUDED.yesterday_dtgraph,   walkdata.yesterday_dtgraph),
       yesterday_stepcount = COALESCE(EXCLUDED.yesterday_stepcount, walkdata.yesterday_stepcount),
       yesterday_distance  = COALESCE(EXCLUDED.yesterday_distance,  walkdata.yesterday_distance);

-- PUT /walk/history: the arrays and the base they were encoded against
UPDATE walkdata
   SET history_base = :base, dtgraph_json = :dtgraph_json, stepcount_json = :stepcount_json, ascend_json = :ascend_json,
       distance_json = :distance_json, iso_json = :iso_json   -- no descend_json: v3 does not keep it
 WHERE userid = :userid;
```

If `PUT /walk/history` arrives before any `PUT /walk/today` for a new user, the server inserts the row first (the history request carries `dtgraph` too, or the insert uses `:base`).
**Built** (`services/walk/putToday.ts`, `putHistory.ts`). **Checks on `PUT /walk/history`** (400 `BAD_HISTORY`): `base` is a multiple of 86400, the four arrays have the same length, and the run lengths of `iso_json` add up to it; `iso_json` entries are 2 capital letters (`ZZ` = unknown). **Checks on `PUT /walk/today`** (answered 400, `BAD_DTGRAPH` or `BAD_YESTERDAY`): `dtgraph` is a multiple of 86400 and within one day of the server's UTC date (a local date is at most about 14 hours from UTC, so no time zone is needed);
`yesterday_dtgraph`, if sent, is exactly `dtgraph - 86400`, and the three `yesterday_*` values come together or not at all. The server does not use `downloads.timezone` for any of this: the phone always knows its own local date.

**The leaderboard for a day (the query behind challengers, read from Postgres, never cached).** The request names the label (`dtgraph`, required, same sanity check). The server does not decide whether it is "today" or "yesterday": a label can sit in either column,
even at the same moment (at 10:00 in India Honolulu is still on `L` while Auckland has moved to `L + 1`), so it reads both. A row has `yesterday_dtgraph < dtgraph`, so a user matches at most one half.

```sql
-- the LIMIT must be inside each half: then each half reads only :n index entries and Postgres merges them
SELECT * FROM (
  (SELECT userid, stepcount           FROM walkdata WHERE dtgraph           = :label ORDER BY stepcount           DESC LIMIT :n)
  UNION ALL
  (SELECT userid, yesterday_stepcount FROM walkdata WHERE yesterday_dtgraph = :label ORDER BY yesterday_stepcount DESC LIMIT :n)
) b ORDER BY stepcount DESC LIMIT :n;

-- the viewer's rank, capped (:cap, for example 1000): users with more steps than they have, per half, added together, plus 1.
-- At the cap the app shows "1000+". Without the cap this counts every user above the viewer.
SELECT (SELECT count(*) FROM (SELECT 1 FROM walkdata WHERE dtgraph           = :label AND stepcount           > :mine LIMIT :cap) a)
     + (SELECT count(*) FROM (SELECT 1 FROM walkdata WHERE yesterday_dtgraph = :label AND yesterday_stepcount > :mine LIMIT :cap) b) + 1 AS rank;
```

Measured on 300,000 synthetic users (local, Postgres 18): the board with the `LIMIT` inside each half takes 0.05 ms (a Merge Append over two backward index scans, about 50 rows read);
the same query with one `LIMIT` outside reads every row of the label and takes about 26 ms, growing with the users. An uncapped rank for a viewer near the bottom counted about 175,000 rows in 21 ms and grows the same way, which is why it is capped.
A user who syncs two or more days late has the older label in neither column (it is only in the history arrays), so they are missing from that older board; a user who was offline for yesterday appears on it as soon as they sync.

The challengers ranking uses the plain columns only. Postgres keeps the unchanged JSON values in place on a `PUT /walk/today` update, so the arrays are
rewritten about once a day instead of on every sync.

## 12. Restore reads

`GET /activities` on the phone's and on the watch's group ([api.md](api.md) section 4). Built in v3 (`services/activities/restore.ts`, `columns.ts`).
- **One statement per page, JSON built in SQL and sent as text.** The page is a `MATERIALIZED` CTE read once by three consumers: the `json_agg` of the rows, the `next` cursor (the last row, if an older row exists), and, on the first page only, `total` (an index-only count on `activities_user_start`). The large arrays are never parsed in Node.
- **Keyset paging:** `ORDER BY startdate DESC, activityid DESC` with `(startdate, activityid) < (:s, :id)`, which is the order of `activities_user_start (userid, startdate DESC, activityid DESC) WHERE tosend > 0`: an index-only read of the keys, 0.05 ms for a page.
- **The watch's list is enforced here, not asked for:** the wearable controller always passes `iswatch = true` and accepts only `limit`, so the watch cannot receive a phone activity ([watch.md](watch.md) section 6). That read can use `activities_user_watch_start`.
- **The start point** (`columns.ts`, `START`): a new-format row (`activitydetail_v2` present) is sent with `ST_Y(geom)` and `ST_X(geom)`, an old-format row with its `lat` and `lon` columns (through `::text::float8`, so a REAL prints as `19.11927`). Old rows can have a wrong `geom` (schema.pg.md section 8, "What the real data shows").
- **Read from the reader.** A restore does not need the last second.
- **Two column lists** (`columns.ts`), built from the same four parts: the small fields, the track, the old small columns (`media`, `media_details`), the old track (`activitydetail`, `activitybpm`). A restore page has all four; the inbox has the first two (watch rows are new-format).
- **Compression:** replies are gzip at level 1 ([api.md](api.md) section 4 has the measurement).
- Nothing is cached ([README](README.md) ground rule 9).

## The feed

`GET /feed` and `GET /feed/:activityid` ([api.md](api.md) section 11) are built from `activities` and `userinfo` in SQL. A page is the small columns plus `route_preview`; it is ordered by `enddate DESC, activityid DESC` (index `activities_feed`) and carries an ETag (304 when unchanged). The server never works a route out: the phone sends `route_preview` with the activity ([format.md](format.md) section 6), and the server stores it (only filled in, never replaced). `npm run backfill:preview` fills it for rows the phone never sent. Image routes have their own limit: 600 a minute per token.

## Posts

`PUT/DELETE /posts/:postid` and `GET /posts` ([api.md](api.md) section 12) store what a user shares from Home. `posts.content` is JSON that the API checks (TypeBox, `schemas/posts.ts`) and then stores as it is; `media_v2` has its own column. The media routes find whether an id is an activity or a post (`services/media/owner.ts`) and run the same code on the right table, so there is one media implementation. The feed merges the two tables by time in one query (each side is cut to a page by its own index, then merged). A deleted post stays as a marker (`tosend = 0`) with its words and media emptied and its S3 folder removed. The rule "media coming, a title or a description" is the API's, not a CHECK: see [schema.pg.md](schema.pg.md) section 11.

## 13. Weather

`POST /phone/v3/weather` ([api.md](api.md) section 13) calls WeatherAPI, and OpenWeather when that fails (`src/services/weather/getWeather.ts`, ported from the old API's `getWeather`). The WeatherAPI condition code gives the text and the icon (`src/services/weather/conditions.ts`; the icon gets `d` from 06:00 to 17:59 at the place, `n` otherwise), PM2.5 gives the 1..5 index (below 10, 25, 50, 75, then above). Nothing is stored. `WEATHER_API` and `OPEN_WEATHER_API` are read per call from the environment (`.env.local` locally, never committed, and not in `.env.test`); the tests stub `fetch`.

## 15. Sign in with Apple and Google

`services/auth/login.ts` (route `POST /phone/v3/auth/login`, [api.md](api.md) section 1b). `providers/verify.ts` checks the token with `jose` (`jwtVerify`) against the provider's key set (`providers/keys.ts`: `createRemoteJWKSet`, cached, refreshed when an unknown key id appears); `providers/apple.ts` makes the client secret (an ES256 JWT, five minutes, signed with the `.p8` Key: `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH` or `APPLE_PRIVATE_KEY`), exchanges the authorization code and **revokes a refresh token** (`revokeAppleToken`, used by the account deletion, section 8: it never throws, a `false` must not stop the deletion; it is logged for a retry). Then the same `loginDevice` as every login. The tests use a local key set and a stubbed `fetch`; nothing leaves the machine.

## 14. Other people's profiles

`GET /phone/v3/users/:userid` (`services/users/getUserProfile.ts`) runs four small reads in parallel on the reader: the `userinfo` row, one row per month for the last 36 (`GROUP BY` the month in the user's own `seconds_from_gmt`; it uses `activities_user_start`), the all-time totals with the three bests, and the number of photos (the length of every `media_v2` of their activities and posts; an old row's `media` names are not counted). `GET /phone/v3/users/:userid/feed` (`getUserFeed.ts`) is the feed's query for one user: each side (activities, posts) is read newest first with its own index and cut to a page, merged and cut again; `kind` leaves one side out and `media` adds `media_v2 <> '[]'` (only fixed fragments are joined into the SQL, values go through `$1..$4`). Both are 404 for a hidden profile unless it is the caller's own, and for a deleted account. Nothing is cached; the screen asks when it opens.
