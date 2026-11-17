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
**Not done yet: removing `activitees/<activityid>/` in S3** (README open item 28).

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
The IP lookup (`X-Location: off`, the `ipref`) is not built yet.

## 8. Deleting an account

`DELETE /account` (the user is from the token). The server:
1. Sets `userinfo.deleted_date` to now. This is when the user deleted the account.
2. Revokes every token of the user (`usertokens.revoked = true`, all devices). A watch's next refresh is refused.
3. If there is an `apple_refresh_token`, revokes it with Apple (Sign in with Apple requires this on account deletion).
4. Deletes the user's files in S3 (every `activitees/<activityid>/` of the user and the profile pictures in `fitpy`) and then the user's rows, in this order
   ([schema.pg.md](schema.pg.md) section 9):
   1. `DELETE FROM quotations WHERE userid = :userid` (its foreign key has no delete action and would block the next step);
   2. `DELETE FROM userlogin WHERE userid = :userid`: this cascades to `activities`, `usertokens`, `user_topics` and the other tables that point at the login (`app_sync` too, until it is dropped);
   3. `DELETE FROM downloads WHERE userid = :userid` (the rows that pointed at them are gone by now);
   4. `DELETE FROM userinfo WHERE userid = :userid`.
5. Answers 204.

Open (README open item 10): whether step 4 happens at once or after a grace period, and what a sign-in during that period does.

## 9. Token clean-up

A daily job deletes token rows that have not been used for **365 days**. This removes the old phone's row after an upgrade to another model, and the rows of installs that were never used again.

```sql
DELETE FROM usertokens
 WHERE GREATEST(COALESCE(accessed_date, 0), COALESCE(changed_date, 0)) < (EXTRACT(EPOCH FROM now())::bigint - 31536000);
```

`accessed_date` is only written when it is more than an hour old, and `changed_date` moves on each login and refresh, so an active device is never deleted.
A refresh token has no expiry of its own today, so this is also its longest life.

## 10. Refresh with a grace period

So that a refresh whose reply is lost does not sign the user out, the row keeps the refresh value from before the last rotation (`prev_refresh_token`, `prev_changed_date`) for 2 minutes.

1. A refresh finds the row where `refresh_token = :hash` (or the raw old value), or where `prev_refresh_token = :hash AND prev_changed_date > now - 120`, and `revoked = FALSE`.
2. It makes new access and refresh values and replaces both. **If the refresh matched the current value**, it also stores the old one: `prev_refresh_token = old refresh_token`, `prev_changed_date = now`.
   **If it matched the previous value** (a retry), it leaves `prev_refresh_token` and `prev_changed_date` as they were, so a second lost reply can be retried too, until 2 minutes after the first rotation.
3. It returns the new pair. Any other refresh value, or the previous one after 2 minutes, answers `LOGOUT`.

## 11. Step history

The `walkdata` row ([schema.pg.md](schema.pg.md) section 10) is stored as received; the server decodes nothing. The user is from the token. `dtgraph` is a date label, not a moment ([README](README.md) section 5).

```sql
-- PUT /walk/today: fixed-size columns only, so the large JSON columns are not rewritten
INSERT INTO walkdata (userid, dtgraph, stepcount, distance, ascend, descend,
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
       descend_json = :descend_json, distance_json = :distance_json, iso_json = :iso_json
 WHERE userid = :userid;
```

If `PUT /walk/history` arrives before any `PUT /walk/today` for a new user, the server inserts the row first (the history request carries `dtgraph` too, or the insert uses `:base`).
**Checks on `PUT /walk/today`** (answered 400, `bad_dtgraph` or `bad_yesterday`): `dtgraph` is a multiple of 86400 and within one day of the server's UTC date (a local date is at most about 14 hours from UTC, so no time zone is needed);
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
