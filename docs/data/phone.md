# Phone (React Native app)

What the phone stores and does. The activity: [format.md](format.md). The requests: [api.md](api.md). The server: [server.md](server.md).
The watch: [watch.md](watch.md).

## 0. Where it is in the code

| Folder | Role |
|---|---|
| `src/data/` | **Access to data, nothing else.** `db/` (SQLite), `mmkv/`, `keychain/`, and `api/` (the HTTP client to the server: token handling, the typed endpoints, the wire types, the version in one place). Only these folders import `op-sqlite`, `react-native-mmkv`, `react-native-keychain` and `axios`, and they import nothing from the screens, stores or features above them (`__tests__/dataLayer.test.ts`). |
| `src/features/sync/` | **What the app does with that data:** the restore (`restore.ts`), the converter from the wire form to the stored form (`codec.ts`), the sign-in flow (`signIn.ts`), the runner that keeps it going (`runner.ts`), the profile mapping, and the in-memory `syncStore`. `api.ts` builds the app's one API with its wiring. |

So the layers are: screens and stores, then `features/sync`, then `src/data`. **A screen never calls the API or touches `src/data`**: it calls a function or a hook from a feature (enforced by the same test).
`src/data/api/endpoints/` has one file per resource (`profile.ts`, `activities.ts`, …), named like the server's route groups, so it grows by adding files, not by growing one.

**How a screen saves or reads something.** The phone is offline first, so most writes are *local*: the feature function changes SQLite or the store, sets the "not sent" flag, and wakes the sync loop, which sends it later. The screen has nothing to catch: it moves on at once.
The few actions that must be online (delete the account, log out) are feature functions that return a typed result (`ok`, or why not: offline, refused, server), and one helper turns that into the toast. The screen does not repeat the request, the `try/catch` and the message. The wire shape (`ServerActivity`, in `data/api/types.ts`) becomes the stored shape (`LocalActivity`, in `data/db/activities.ts`) only in `features/sync/codec.ts`.

## 1. Stores

| Store | Holds |
|---|---|
| op-sqlite | Activities (section 2). There is no separate upload queue: the flags on the rows are the queue (section 4). |

The MMKV keys and the Keychain items are listed in [schema.phone.md](schema.phone.md) sections 2 and 3.

**The device id** is sent with every login (`deviceid`, [api.md](api.md) section 1): on iOS `DeviceInfo.getUniqueId()` (a UUID, different for every phone, kept across an uninstall); on Android a UUID the app creates on its first launch
and keeps in the Keychain (lost on uninstall, so a reinstall makes a new row, which the server removes after 365 days). It is **never wiped**, not even on logout or account deletion: wiping it would create a new row at every sign-in.

| react-native-mmkv | Settings, flags, cursors (restore page), the profile and its flag (section 9), the last `ipref`, small cached server blobs |
| react-native-keychain | Refresh token, the key that encrypts MMKV |

The access token lives in memory only. Native (iOS `ActivityStore`, later Kotlin) holds the raw
recording until `consumed` (section 3).

## 2. The activities table

The table, its indexes and checks: [schema.phone.md](schema.phone.md) section 1. The arrays are the decompressed (absolute) form as JSON text
([format.md](format.md) section 2). `synced` is 0 (not on the server) or 1; `delete_pending` is 1 while a delete waits for the server.
Lists, the calendar and feeds select the summary columns only (and `WHERE delete_pending = 0`), never the array columns.

## 3. Finishing an activity (native to React Native)

1. Native finalises the activity and emits `finished { activityId, summary }`. It keeps the raw samples.
2. React Native reads the points from native in pages of 500 to 1,000 (`readPoints(activityId, offset, limit)`), not one at a time over the bridge.
3. It computes everything from the full track: distance, pace, splits, elevation gain, scoring, streak and plan progress.
4. In **one SQLite transaction** it writes the activity row with `synced = 0` (the totals and the arrays in the local form), and any streak and plan changes.
5. It calls `consumed(activityId)`. Only then does native delete its copy.
6. The sync loop (section 4) sends it.

Safe to repeat: steps 2 to 5 are keyed by `activityId`. If the app dies before step 5, native still has the
data and `pendingActivities()` hands it over again on the next launch.

## 4. The sync loop

The flags on the rows are the queue. The loop does **one step at a time** (a request is never in flight beside another), in this order:

1. **Deletes:** every row with `delete_pending = 1`: `DELETE /activities/{activityid}` ([api.md](api.md) section 5).
2. **Activities:** up to 20 rows where `synced = 0 AND sync_error IS NULL AND delete_pending = 0`, oldest first. This covers
   new activities and edited ones. Compact them in memory, send them ([api.md](api.md) section 2), and apply every item's result in **one transaction**.
3. **Media:** for each activity that is on the server (`synced = 1`), upload its prepared media items that have no `value`, one file at
   a time in order (presign, upload, commit; [api.md](api.md) section 6), and store the `value` the server returns.
4. **Profile:** if `profile_synced` is false, send it (section 9).
5. **Step history:** if any completed day has `synced = 0` (section 11), send `PUT /walk/history`. This always goes **before** today's update, so a day's final numbers reach the server before today's update replaces them.
6. **Steps today:** if `walk_today_synced` is false, send `PUT /walk/today`.
7. Repeat until nothing is left.

Triggers: an activity finishing, the app coming to the foreground, the network coming back, and a
background task. Failures retry after 5 s, 15 s, 1 min, 5 min, then every 15 min, with jitter, and the
timer resets on a new trigger. Because repeats are harmless ([server.md](server.md) section 2), a lost reply never causes a duplicate.

## 5. Editing and deleting

**Editing.** An edit changes the local row and sets `synced = 0`. The next pass sends the activity again, like a new one.
On the server the repeat applies only the editable columns (`media_v2`, `description`), so the track is never changed by a resend.

- **Removing a media item:** take it out of the local `media_v2` list and set `synced = 0`. The server
  stores the new list and deletes the files that are not in it ([server.md](server.md) section 3). `tosend` stays `1`. The phone deletes its local copy of the file.
- **Adding media:** the new item is in the local list without a `value`; step 3 of the loop uploads it.
- **Changing the track** (for example trimming) is not supported by this rule, because the server ignores the track on a repeat.
- A resend carries the whole activity (about 15 KB compressed for an hour). Edits are rare, so this is the simpler rule. If
  it ever matters, the client can leave the track out of a resend, since the server ignores it.

**Deleting.** The activity is deleted on the **server first, then on the device**.
1. The user deletes. The row gets `delete_pending = 1` and disappears from every list at once. Step 1 of the loop sends the delete. This works offline.
2. On the answer (204, or 404 for an unknown id), the phone deletes the row and its local media files.
3. If the activity was recorded on the watch, the phone also sends the watch a `deleted { activityid }` message (WatchConnectivity `transferUserInfo`, queued),
   and the watch removes its copy ([watch.md](watch.md) section 5). A watch message arriving at the phone is handled the same way.
4. If the server answers `deleted` to an upload, the phone removes its copy.

## 6. Preparing media

Everything is prepared on the phone. Limits come from settings the app caches (changeable from the server
without an update); the server enforces only a hard size cap.

| | Photo | Video | Poster |
|---|---|---|---|
| Size | longest side 2048 px | longest side 1280 px (720p), at most 30 fps | longest side 1280 px |
| Quality | 80% | H.264 + AAC in MP4, about 2.5 to 3 Mbps, audio about 128 kbps, index at the front | 80% |
| Length | — | **30 seconds** (setting `videoMaxSeconds`) | — |
| Size cap | about 3 MB | about 25 MB | about 1 MB |
| Format | WebP (`.webp`) | `.mp4` | WebP (`.webp`) |

**Photo** (the native media module, section 7). Shrink to 2048 px on the longest side without loading the full picture, apply the
orientation to the pixels, convert to sRGB, and encode **once** as WebP at 80%. No metadata is written, so no GPS location is in the file.
`react-native-compressor` is not used for photos: it writes only JPEG or PNG, and on iOS it copies the original's metadata (including
location) into the new file.

**Video:**
1. Read `duration`, width and height with the compressor's `getVideoMetaData`.
2. **The user chooses which part to share.** A video longer than the limit opens the **trim screen** straight away; a shorter video has a
   "Trim" button. The screen shows a preview (`react-native-video`, already installed), a timeline and two handles, and the chosen part can be
   **any stretch of the video up to the limit**, not the first seconds. It starts with the first 30 seconds selected and the user drags it
   to where they want. A strip of frames under the timeline comes from the native module (`videoFrames`).
3. The chosen part is cut out **without re-encoding** (`trimVideo`, a passthrough cut, native), so the next step is the only lossy pass. A cut
   snaps to the nearest keyframe (about a second on iPhone video), so the length can differ from the choice by about a second; the 30 second
   check uses the length of the cut file, with a one-second allowance.
4. `Video.compress` (`react-native-compressor`) with `compressionMethod: 'manual'`, `maxSize: 1280` and a bitrate for the target above. It
   reports progress and can be cancelled. On iOS it already asks for the file to be optimised for streaming. Check that HDR phone videos
   come out with correct colours (README open item 3).
5. If the result is over the size cap, compress once more at a lower bitrate.
6. **Poster:** `createVideoThumbnail` with the highest quality, then the same photo step, so the poster ends as WebP. Its size gives the poster `dimension`.
7. Read `dimension` and `duration` from the finished file.

Compression takes about as long as the video itself, so it runs in the foreground with progress. If the app is killed, it starts again from the
original. The original is not kept after the compressed file is made. The prepared file lives in the app's documents folder.

**The local row.** Each media item in the phone's row is `{ type, uri, dimension, duration?, posterUri?, value?, poster? }`. Until it is uploaded
it has no `value`. After the upload it gets its `value` (and `poster`) and keeps its `uri`, so the picture opens offline. `uri` and
`posterUri` stay on the phone and are never sent. After a reinstall, items have a `value` only, and the picture loads from S3 and is cached.

## 7. The native media module

A small module in the same style as the others (Swift on iOS, Kotlin on Android, the logic that decides sizes tested in `native-tests`):

| Function | Does |
|---|---|
| `preparePhoto(uri, maxEdge, quality)` | Returns `{ uri, width, height, bytes }`: shrunk, upright, sRGB, WebP, no metadata. iOS: ImageIO for the shrink and libwebp for the encode (ImageIO cannot write WebP). Android: `BitmapFactory` with a sample size, then `Bitmap.compress` with WebP lossy. |
| `trimVideo(uri, start, duration)` | A passthrough cut. iOS: an export session with a time range. Android: `MediaExtractor` and `MediaMuxer`. |
| `videoFrames(uri, count, size)` | Evenly spaced stills for the trim strip. |

## 8. Restore and the inbox

**Restore, on reinstall or login: everything, in full** ([api.md](api.md) section 4). The app is usable while it restores.
1. `GET /activities?limit=50`, then `before=<next>`, until `next` is `null`. The first page also has `total` (for a progress bar).
2. Each page is inserted in **one transaction** with `synced = 1`, by `INSERT OR IGNORE` (an activity recorded here during the restore wins). Old-format rows are converted ([format.md](format.md) section 3).
3. The cursor is saved in MMKV after each page (`restore_cursor`). An interrupted restore resumes from it.
4. The day of an activity comes from `activitydetail_v2.tz`, or from `dtgraph` for an old-format row.
5. **What is stored** is the decompressed form ([format.md](format.md) section 2): the coordinate and time arrays become absolute values (a running sum from the start point in 1e-5 degrees, and from `startdate`), an old row's `media` names become `media_v2` photo items, and its `activitybpm` (one bpm per location update, zeros are no reading) becomes `activitybpm_v2` with the times of those points. Built in `src/features/sync` (`codec.ts`, `restore.ts`, `activityDb.ts`).
   Checked on two real accounts (2,092 activities, old format) against a real SQLite: the decoded track length is within 0.8 to 1.25 of the stored distance for 86 to 89 percent of the activities (median 0.99 and 1.03), the first point is the start point, and replaying every page changes nothing.
6. **Sign-in (debug builds).** Continue with Apple or Google, on the Welcome screen, signs in to the local v3 server as the user the server maps to that provider (`DEV_USER_APPLE`, `DEV_USER_GOOGLE`), and shows "Signing in…" on the button.
   **The server decides whether the user is new:** `GET /profile` answers 404 for a user with no profile, who goes on to the setup steps; a user with a profile has it taken into the app and is welcomed back. A failure stays on the Welcome screen with its reason in a toast. There is **no demo account and no sample activity history**: the Activities, Activity stats and Plan overview screens show what the phone has stored, and an account with none shows empty states.
   **Test users:** above the two buttons a debug build lists the three test users in the local database (`src/features/sync/devUsers.ts`: a long history, some history, and one just installed) as links: one tap signs in as exactly that user (`dev-login` with a `userid`, which wins over the provider mapping). They are not there in a release build.
   The real Apple and Google sign-in will replace the first step only.

## 8b. The activity details screen

An activity of your own opens with its stored track (`useStoredActivity`, from `src/data/db`), and everything on the screen is **worked out on the phone** from it (`features/activity/detail.ts`, `buildActivityDetail`): the route (simplified for drawing only, 4 m), pace and grade-adjusted pace every 1/63 of the distance, splits per km or mile from the full track, pace and heart rate zones, elevation, steps and weather.
Only the sections that have data are shown, with their chips: no track, no Pace and Splits; no heart rate readings, no Heart rate and no HR column; no altitude, no Elevation; no steps, no Steps; no temperature, no Weather; **Power is never shown**, nothing records it.
Notes: the distance on the screen is the saved distance, and the route's own length is stretched to it when it is within a quarter (so the splits agree with the total); the pace zones add up to the track's own time; `activitydistance` is not used (format.md section 2); temperatures are converted from kelvin; a feed post and the plan's sample last run have no stored track and still show a sample.
What is not connected yet: the photos (`media_v2` and the media upload), and saving an edit of the title or note (it stays on the screen until activities are sent back to the server).

**The inbox.** Watch activities the phone has not seen ([api.md](api.md) section 3):
1. `GET /activities/inbox?limit=20`.
2. Decompress each one and `INSERT OR IGNORE` it with `synced = 1` (the server already has it).
3. `POST /activities/ack` with the ids. The ack is a few bytes, so the phone does not re-upload the whole activity.
4. Repeat until the inbox is empty.

Triggers: app launch, foreground, and after sign-in. A silent push when the watch uploads is optional and can come later.

**A watch activity sent directly by the watch** arrives decompressed and is inserted as it is, with `synced = 0` and `iswatch = 1`, then uploaded by the loop
([watch.md](watch.md) section 3). The phone replies to the watch that it has it.

## 9. Profile and location

**The profile.** One JSON object in (encrypted) MMKV, with `profile_synced` (true or false).
- On login: `GET /profile` and store it.
- An edit changes the stored object and sets `profile_synced = false`. Step 4 of the loop sends it (`PUT /profile`, a few hundred bytes), and the app sets it true. The last write wins.
- Works offline like everything else. The watch never changes the profile.

**Pictures.** Same rules as activity media (section 6): prepared as WebP (suggested: profile picture 512 px, cover 1600 px, quality 80, as settings) and uploaded
straight to S3 ([api.md](api.md) section 7). Until the commit, the phone shows its local file.

**Time zone.** Needs no location permission. The phone reads its time zone name and sends it with the profile whenever it changes.

**Location.** The server decides what it does from the `X-Location` header ([server.md](server.md) section 7):
- Send `X-Location: on` or `off` on every request, and keep the latest `ipref` to send back as `X-Ipref`.
- **Permission off:** the server tracks by IP address. When the user turns it off, drop the stored `ipref`, so the server makes one lookup on the next request.
- **Permission on:** the phone sends its location, and everything is done on the phone:
  - A fix is taken **when the app opens** (at most once every 6 hours), and **the start point of every finished activity** counts as a fix too (no extra GPS use).
  - If it is more than about 10 km from the last location sent, or in a different city, the phone finds the city, state and country with the device's own reverse lookup, and sends
    `PUT /profile/location` with `{ lat, lon, city, state, iso }`. The coordinates are exact, not rounded.
  - If the reverse lookup cannot run (no network), the phone keeps the fix and tries again later.
  - **Built so far:** the server side, and the typed call `api.profile.putLocation({ lat, lon, city, state?, iso })` in `src/data/api`. **Not wired yet:** taking the fix when the app opens and at the end of an activity, the 10 km / new city test, the reverse lookup, and sending it. The server answers the country's name with the place, so the phone keeps no list of country names. A 404 means the profile is not saved yet: keep the fix and send it after the profile.
- On the first request after install, send `regionHint` (the device's region) so the server has a first guess for `iso` if its lookup fails.

## 10. Deleting the account, and logout

**Delete account** (Edit profile, then Delete account). This is the one action that needs a connection and is never queued.
1. The user confirms. If there is no connection, say so and stop.
2. `DELETE /account` ([api.md](api.md) section 8). On 204:
3. Tell the watch (`accountDeleted` over WatchConnectivity). Wipe SQLite, MMKV, the Keychain (including the encryption key, but not the device id) and the prepared media files. Discard anything native still holds. Go back to the sign-in screen.
4. A watch that did not get the message is logged out by its next refresh, which is refused, and wipes itself ([watch.md](watch.md) section 6).

**Logout** needs a connection (it must revoke this device's refresh token, [api.md](api.md) section 1). Offline, or on a server error, it fails and the user stays signed in; the screen says to connect first.
**Logout deletes no app data.** SQLite (activities, steps), MMKV, the MMKV key, the prepared media files and the device id all stay. Only the session goes: the refresh token in the Keychain and the access token in memory.
Rows with `synced = 0` or `delete_pending = 1` therefore stay on the phone, and the next sign-in simply carries on the sync loop and uploads them, as it would after any offline period. Nothing is warned about or waited for at logout.
**Who signs back in decides.** The app keeps `last_userid` (Keychain item, not removed at logout). At every login, before the tokens are stored and before the sync loop starts:
- **Same `userid` as `last_userid`** (or no `last_userid` yet, the first login): keep everything and carry on syncing.
- **A different `userid`**: wipe the previous user's data first (SQLite, MMKV, the prepared media files; not the MMKV key or the device id), then store the new `last_userid`. The first user's unsynced rows are lost; this is the decided behaviour.
Only **Delete account** otherwise wipes the phone (above), and it removes `last_userid` too.

All times are epoch seconds in UTC. The local day comes from `activitydetail_v2.tz`.

## 11. Step history

The phone keeps one row per day ([schema.phone.md](schema.phone.md) section 1, `steps_daily`) and builds the compact arrays only when it sends them ([format.md](format.md) section 5).

- **A day** is a `dtgraph`, the local date as midnight UTC ([README](README.md) section 5).
- **The device computes** each day's totals (steps, distance, floors up and down) and the day's country, and writes them to `steps_daily`. Today's row changes all day.
- **Today:** after each change, set `walk_today_synced = false`. Step 6 of the loop sends today's plain columns and the records. A record (`max_steps`, `max_distance`) is `MAX` over `steps_daily`, including today, and is sent with the same request.
- **Yesterday:** with every `PUT /walk/today`, add `yesterday: { dtgraph, stepcount, distance }` from `steps_daily` for `today - 86400`, if that row exists (leave it out otherwise). The server only stores it, for yesterday's leaderboard; a late watch backfill is picked up on the next call.
- **History:** a completed day (before today) that is new or changed (late data from a watch or a backfill) gets `synced = 0`. Step 5 of the loop then builds the arrays from **all** completed days: days with no data are left out (so the deltas show a gap),
  `base` is today's day, `dtgraph_json = encodeDeltas(days, base)`, `iso_json = rleEncode(isos)`, and the three number arrays follow the same order. It is sent gzip-compressed, and on success every completed row gets `synced = 1`. When a day closes, this
  is sent once.
- **Order.** History goes before today's update. If the history request fails, today's update waits, so a closed day's numbers are never overwritten on the server before they have arrived.
- **The world map** is `SELECT iso, SUM(steps) FROM steps_daily GROUP BY iso`, on the phone.
- **Restore:** `GET /walk` ([api.md](api.md) section 10). A row with `history_base` set: decode the arrays against it (`decodeDeltas`, `rleDecode`), insert the days with `synced = 1`, then add today (or the latest day) from the plain columns. A row without it (old form): decode
  against `dtgraph`; the last entry is today.
