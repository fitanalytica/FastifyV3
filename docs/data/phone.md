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

## 3b. Place and weather (before an activity is sent)

An activity recorded on the phone is **not sent to the server until it has its place and its weather** (`activities.needs_conditions`, [schema.phone.md](schema.phone.md) section 1; `features/activity/conditions.ts`). The place (`city`, `state`, `iso`) comes from Apple's geocoder, the weather (`temp` and `realfeel` in kelvin, `humidity`, `wind` in km/h, `uvi`, `aqi`, `weathericon`, `weather`) from the server's `POST /weather` ([api.md](api.md) section 13), which holds the providers' keys.

1. **At the start** of an outdoor activity (once the engine runs; never held up by it): the phone takes one position, looks up both in parallel, and keeps what it found in MMKV (`activity_start_conditions`) so closing the app mid-activity loses nothing. Nothing is kept when there is no position or both lookups fail.
2. **When it is saved** (section 3): what the start found is used if it is within an hour and 5 km of the activity's start (a find of another activity is never used) and removed. The row is saved with `needs_conditions = 1` unless it has both.
3. **After it is saved, and on every later pass** (app start, the app coming to the front, a connection, a new activity; before step 2 of section 4): for each waiting activity (5 a pass, newest first), the **missing** half is looked up from its start point (the weather is then the weather of that moment, which is the best an offline activity can have). The activity is let go (`needs_conditions = 0`) once it has both; one lookup with no answer stops the pass and the rest wait for the next. A place the geocoder answers with no name (open water) counts as found. An activity with no start point (0, 0) is let go at once: nothing could ever be found.
4. **Step 2 of the sync loop skips** activities with `needs_conditions = 1`. Migration 008 sets it on unsent activities saved before this existed that lack a weather or a place. A restored activity, one the server already has, and an edited one are never held back.

If neither provider answers (502 or 503 `WEATHER_UNAVAILABLE`), the activity stays on the phone, complete and visible in the lists, and is tried again on the next pass.

## 4. The sync loop

The flags on the rows are the queue. The loop does **one step at a time** (a request is never in flight beside another), in this order:

1. **Deletes:** every row with `delete_pending = 1`: `DELETE /activities/{activityid}` ([api.md](api.md) section 5).
2. **Activities:** up to 20 rows where `synced = 0 AND sync_error IS NULL AND delete_pending = 0 AND needs_conditions = 0` (section 3b), oldest first. This covers
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

**Deleting.** The activity is deleted on the **server first, then on the device**. (Built: the **delete button on the activity's details screen** asks first, "Delete this activity?"; `features/activity/delete.ts`.)
1. The user deletes. The row gets `delete_pending = 1` and disappears from every list at once. Step 1 of the loop sends the delete. This works offline.
2. On the answer (204, or 404 for an unknown id), the phone deletes the row. **Its photos and videos (the saved copies and any waiting to be sent) are deleted from the phone at once**, with the delete, not when the server answers. A server that cannot be reached leaves the row marked; it stays off the lists, and the next run (app start, the app coming to the front, a connection) tells the server.
3. If the activity was recorded on the watch, the phone also sends the watch a `deleted { activityid }` message (WatchConnectivity `transferUserInfo`, queued),
   and the watch removes its copy ([watch.md](watch.md) section 5). A watch message arriving at the phone is handled the same way.
4. If the server answers `deleted` to an upload, the phone removes its copy.

## 6. Preparing media

Everything is prepared on the phone. Limits come from settings the app caches (changeable from the server
without an update); the server enforces only a hard size cap.

| | Photo | Video | Poster |
|---|---|---|---|
| Size | longest side 1280 px | longest side 1280 px (720p), at most 30 fps | longest side 1280 px |
| Quality | 80% | H.264 + AAC in MP4, about 2.5 to 3 Mbps, audio about 128 kbps, index at the front | 80% |
| Length | — | **30 seconds** (setting `videoMaxSeconds`) | — |
| Size cap | about 3 MB | about 25 MB | about 1 MB |
| Format | WebP (`.webp`) | `.mp4` | WebP (`.webp`) |

**Photo** (the native media module, section 7). Shrink to 1280 px on the longest side (one copy; smaller to send and to hold, and it fills a card) without loading the full picture, apply the
orientation to the pixels, convert to sRGB, and encode **once** as WebP at 80%. No metadata is written, so no GPS location is in the file.
`react-native-compressor` is not used for photos: it writes only JPEG or PNG, and on iOS it copies the original's metadata (including
location) into the new file.

**Video:**
1. Read `duration`, width and height with the compressor's `getVideoMetaData`.
2. **The user chooses which part to share (built).** Every video picked in Memories opens the **trim screen** (`TrimVideo`, full screen) before anything is prepared; a photo never does. It plays the part on a loop (`react-native-video`) and shows a strip of frames with two handles: drag a handle to move that end, drag the part between them to slide it. The part is **at most 30 seconds** (`videoMaxSeconds`), **at least 1 second**, and starts as the first 30 seconds (or the whole video when it is shorter). Dragging a handle so that the part would pass 30 seconds pulls the other end along. "Use this part" keeps the choice; the **x** (or any other way out of the screen) **skips that video** with no message, and the other files picked go on. The rules are in `src/features/media/trim.ts` (pure, tested); the screen hands its answer back to the add flow through `trimRequest.ts`. "Preparing" shows only after the choice. The strip of frames is `videoFrames` (native, section 7), made when the timeline's width is known and deleted when the screen goes.
3. **The cut.** A part that is not (within a quarter of a second) the whole video is cut out **without re-encoding** (`trimVideo`, a passthrough export, native), so it is fast and loses nothing and the next step is the only lossy pass. A cut snaps to the nearest keyframe (about a second on iPhone video), so its length can differ from the choice by about a second; the 30 second check uses the length of the cut file, with a one-second allowance. The cut file is the one compressed, and it is deleted afterwards (also when preparing fails). The whole video chosen is not cut: the original is compressed as it is.
4. `Video.compress` (`react-native-compressor`) with `compressionMethod: 'manual'`, `maxSize: 1280` and a bitrate for the target above. It
   reports progress and can be cancelled. On iOS it already asks for the file to be optimised for streaming. Check that HDR phone videos
   come out with correct colours (README open item 3).
5. If the result is over the size cap, compress once more at a lower bitrate.
6. **Poster:** `createVideoThumbnail` with the highest quality, then the same photo step, so the poster ends as WebP. Its size gives the poster `dimension`.
7. **`dimension` is the size as SEEN, taken from the poster** (the poster is made with the video's rotation applied), not from the video track: a phone's portrait video is stored as a landscape 1280 x 720 track with a 90 degree turn, so the track's own width and height would call it landscape. `duration` is read from the video.

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
| `trimVideo(uri, start, end)` | A passthrough cut, in seconds. iOS: an export session with a time range. Android: `MediaExtractor` and `MediaMuxer`. |
| `videoFrames(uri, count, maxEdge)` | Evenly spaced stills for the trim strip (the middle of equal slices). |

## 8. Restore and the inbox

**Restore, on reinstall or login: everything, in full** ([api.md](api.md) section 4). A returning user waits for it on the Welcome Back screen (below); a restore that is cut short carries on in the background.
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
7. **The Welcome Back screen waits for the restore** (`WelcomeBackScreen`, logic in `src/features/sync/welcomeGate.ts`), so the app opens complete:
   - "Logging you in" until the first page says how many there are, then "Restoring your activities", a progress bar and "1,240 of 2,010" (`restore_loaded` of `restore_total`).
   - It opens the app (Setup done) when the restore is done, but not before 1.6 seconds. A user with nothing to restore passes straight through.
   - After 10 seconds of restoring, **Continue anyway** appears; it opens the app and the restore carries on in the background.
   - If the server cannot be reached: "Can't reach the server", **Try again** (restarts the restore from its cursor) and **Continue anyway**. The app never blocks a user offline.
   - So the Activities screen only shows its empty state to a user who really has none (or who chose Continue anyway).

### Photos on the phone

The photos of the user's own activities are saved on the phone, **over Wi-Fi only** (a setting for mobile data may come later), so they show offline ([schema.phone.md](schema.phone.md) sections 1 and 4). Code: `src/features/media` (`download.ts` is pure and tested with fakes; `library.ts` is the glue to the database, files and network state).
1. **When it runs:** when a restore finishes (and on every start with a finished restore), when the app comes back to the front, and when the phone joins Wi-Fi. One run at a time; a run that is going is left alone.
2. **What it does:** takes the next 20 photos still to save (newest activities first), one at a time, asking for Wi-Fi before every file, so leaving it stops the run at once. Each file is `GET /media/:activityid/:value` ([api.md](api.md) section 6) with `X-Access-Token`. A new token is taken once on a 401 or 403.
3. **Outcomes:** saved (a `media_files` row, state 1), the server has no such file (404: state 2, not asked again), or a failure (the run stops and the photo is tried next time).
4. **Showing:** `mediaSource` gives the saved file when there is one (no request, works offline) and the server address otherwise. Other people's photos (the feed) stay in the image cache.
5. **Videos:** a video itself is not downloaded (it is played from the server, or from the phone's own copy when the user added it here), but its **poster** is, like a photo. **Not in a run:** the author's picture, and photos of activities not yet restored.
### Photos and videos you add (Activity details > Memories)

The user adds photos and videos to their own activity from the **Memories** card, and removes them with the **x** on a tile. Everything works offline: a file is prepared and kept on the phone at once, shown at once, and sent when it can be. Code: `src/features/media` (`memories.ts` the actions and the card's model, `prepare.ts` the preparation, `upload.ts` the pure upload loop, `uploadLibrary.ts` the glue to the database, files, network and API).
1. **Adding:** the picker (photos and videos, several at once, no camera metadata read) is asked for no more than the activity has room for (20 in all, the same number the server enforces; a refused upload does not count). Each pick is prepared on the phone ([section 6](#6-preparing-media)): a photo by the `MediaPrep` native module (1280 px, WebP 80 %, upright, sRGB, no metadata, [native-engine.md](../native-engine.md) section 9c2); a video by `react-native-compressor` to 720p H.264 at about 2.5 Mbps (once more, lower, if it is over 25 MB), with a WebP poster from one of its frames. **A video is trimmed first** ([section 6](#6-preparing-media): the trim screen); one the user leaves without choosing is skipped, and a file whose cut is still over 30 seconds (a refusal from the check, which a keyframe snap of more than a second could cause) is refused with a message. **The same photo is not added twice to an activity:** the prepared photo's SHA-1 is compared with the activity's waiting and saved photos ([schema.phone.md](schema.phone.md) section 1, "Duplicates"); a duplicate is dropped with the message "That photo is already in this activity." The prepared file waits in `<documents>/media-pending/<id>.<ext>` and a row is added to `media_uploads` ([schema.phone.md](schema.phone.md) section 1). The original is never kept. While files are prepared, the add tile shows how far.
2. **Sending:** the loop (`runUploads`) sends removals first, then uploads oldest first, one at a time, asking for the connection before each file. **A photo goes on any connection; a video only on Wi-Fi.** An upload is only sent for an activity the server has (`synced = 1`). Each is a poster `presign` + `PUT` (videos), a `presign` + `PUT` of the file, and a `commit` ([api.md](api.md) section 6). When the server has it: the file moves from `media-pending/` into `media/<activityid>/<value>` and gets a `media_files` row (so it shows offline and is not downloaded again), the activity's `media_v2` becomes **the server's list** (minus anything the user removed that the server has not been told yet), and the `media_uploads` row goes.
3. **Outcomes:** done; **refused** by the server (400, 404, 409 `MEDIA_LIMIT`, 413, 422: kept out of the loop, the tile says "Not added" until the user removes it); or a failure to reach the server or S3 (the loop stops and the file waits: it is tried again next time). A PUT that S3 does not accept is a failure to try again, not a refusal of the file.
4. **When it runs:** after a file is added or removed, when a restore finishes, when the app comes back to the front, and when the connection changes. One run at a time.
5. **Removing:** the tile leaves at once. A file still waiting to be sent is simply forgotten with its pending files. One the server has leaves the activity's `media_v2`, its local files and `media_files` row go (a video's poster too), and a row is added to `media_deletes`; the loop then sends `DELETE /media/:activityid/:value` (204 and 404 both mean it is gone) and removes the row. If the user removes a file **while it is being sent**, the server's new file is queued for deletion as soon as the commit answers.
6. **Showing:** the card lists the server's items in their order, then the files waiting. A video shows its poster with a play badge and its length, and **keeps its shape** (a portrait video is a narrow tile, in the feed a narrow page, the same 230 pt height as a photo; the shape is the stored `dimension`, replaced by the one the picture or video reports when it loads, which also fixes a video stored with a sideways size); one waiting says "Waiting"; one refused says "Not added". Tapping opens the photo or video full screen; a video plays from the phone's own file when it has one, else from the server (`X-Access-Token`).
7. **Not covered yet:** downloading videos for offline (only posters are downloaded); the settings (`photoMaxEdge`, `videoMaxSeconds`, …) come from constants in `settings.ts` until the app caches them from the server (`settings_media`); a "download over mobile data" setting.

### Profile picture and cover (Edit profile)

The camera button on the picture and the pen on the cover open the photo sheet: **Take a photo**, **Choose from library**, and **Remove current photo** (only when there is one). Code: `src/features/profileImage` (`library.ts` the actions and the glue, `ops.ts` the pure sending loop, `source.ts` how an image is loaded, `useProfileImages.ts` what the screen shows).
1. **Choosing:** the permission sheet comes first if it must (camera or photos); then the camera or the library opens **with a crop**: the picture square with a circle overlay (1024 px), the cover as wide as the Edit profile hero (1750 x 1000), no camera data read. A cancelled picker changes nothing.
2. **Preparing:** the same native module as the activity photos ([native-engine.md](../native-engine.md) section 9c2): the picture to **512 px**, the cover to **1600 px**, WebP at 80 %, no metadata. The file waits in `media-pending/` and a row goes into `profile_image_ops` ([schema.phone.md](schema.phone.md) section 1). **It is shown at once**, before it is sent.
3. **Sending (any connection, they are small):** `presign` + `PUT` + `commit` ([api.md](api.md) section 7b). On success the file moves to `<documents>/profile/<server name>`, the profile's `picture` / `cover` becomes that name, and the previous copy on the phone is deleted (the server deletes its old file). A server **refusal** (400, 404 no profile yet, 413, 422) drops the change and its file; a failure to reach the server leaves it for next time. A PUT that S3 does not accept is a failure to try again. A change made again while one is being sent replaces the row, and the finished one never deletes the newer.
4. **Removing:** a `reset` row; the screen shows the initials (picture) or the default cover at once; the server clears the name and deletes the file; then the phone's copy goes.
5. **When it runs:** after a change, when a restore finishes, when the app comes back to the front, and when the connection changes (the same triggers as the activity media).
6. **Showing:** your own picture or cover: a change waiting (the new file, or nothing for a reset), else the phone's copy, else the server's address with the token (`X-Access-Token`). Other people's pictures (the feed's authors) load from the server and stay in the image cache. After a restore, the phone saves its current picture and cover if it does not have them.
7. **Not covered yet:** the cover of someone else's profile page (their profile screen is still empty); the picture on screens other than Edit profile and the feed.

## 8b. The activity details screen

An activity of your own opens with its stored track (`useStoredActivity`, from `src/data/db`), and everything on the screen is **worked out on the phone** from it (`features/activity/detail.ts`, `buildActivityDetail`): the route (simplified for drawing only, 4 m), pace and grade-adjusted pace every 1/63 of the distance, splits per km or mile from the full track, pace and heart rate zones, elevation, steps and weather.
Only the sections that have data are shown, with their chips: no track, no Pace and Splits; no heart rate readings, no Heart rate and no HR column; no altitude, no Elevation; no steps, no Steps; no temperature, no Weather; **Power is never shown**, nothing records it.
Notes: the distance on the screen is the saved distance, and the route's own length is stretched to it when it is within a quarter (so the splits agree with the total); the pace zones add up to the track's own time; `activitydistance` is not used (format.md section 2); temperatures are converted from kelvin; a feed post and the plan's sample last run have no stored track and still show a sample.
**The heading** (Sketch: "Header D2 - Type as card title"; `DetailHeading`) is the same for your activity and someone else's, with a map or without. It shows who (a 56 pt avatar, or initials, and the name), where, and when, then a **card titled by the kind of activity** (a walk, run or ride icon and the word: **Walk**, **Run**, **Ride**, and **Indoor walk** and so on when it has no route) over the **distance** on the left and the **time** and **pace** on the right. **A long place wraps** onto more lines; it is not cut off. **The kind is worked out from how fast it went** (`activityKind`: slower than 7:00 a km is a walk, faster a run, faster than 4:00 a km, 15 km/h, a ride; the same rule the feed uses), because the type chosen when recording is not stored with the activity (the server has no column for it). An activity with no route is **indoor**.

**Opened from an Activities row**, the row grows into the screen and its pieces fly over: its time to the date line, its place, its distance, its duration and its pace (`SharedElement` tags `time`, `place`, `distance`, `duration`, `pace`, kept on the heading's pieces; the row's date tile has no counterpart and fades). The tags are the contract between the row (`ActivityLogRow`) and the heading: a change to one needs the other.

**Opened from a feed post's map**, the map animation is the shared-element one, and then the **sheet eases up into its place on a soft spring** (it starts 120 pt below it and unseen, fades in as it rises, and settles with barely any overshoot) once the screen has finished opening, with the **map's controls** (satellite and replay, `FloatingMapControls`) staying out of sight while the sheet is far down and then riding its top edge up. Opened from an Activities row, or any other way, the sheet and the controls are simply there. (`RiseOnOpen` starts the spring; the screen's `rise` value is how far below its place the sheet is.) **The room under the last section is inside the sheet** (its own background), not in the scroll area: with only the heading to show there is none, and the page does not scroll, so there is no strip of map below the sheet.

**Opened from Done on a finished activity** (Add activity): an outdoor activity with a route opens its details, over the same shared-element transition as a feed post's map. The finished card grows into the screen (its corners easing to square), its **distance, time and pace** fly into the heading (the tags `distance`, `duration`, `pace`), and the **map** flies from the part of the screen it showed above the card into the full-screen map, with the route, on the same soft rise of the sheet. An indoor activity, or one with no route, just sets up the next one. The finished activity is cleared from the Add activity screen 800 ms after the screen has opened over it (so going back lands on the setup card, and the pieces fly home to where the card was). **Sending** (`features/activity/send.ts`, `syncActivities`; step 2 of the loop, section 4): up to 20 waiting activities (`synced = 0`, no `sync_error`, not deleted), oldest first, are sent as one `POST /activities/batch` in the compact wire form (`encodeActivity`: coordinates as increments from the start point, times from `startdate`) **with the route preview** the feed draws its map from (`routePreview`: the same RDP, 6 m and 120 points, as the server's own, which must agree). The result of each item is applied in one transaction: `created` and `exists` mark it sent, `deleted` drops the phone's copy, `invalid` keeps the reason in `sync_error` (not tried again), and an item the server did not answer is left to be tried again. A failure to reach the server stops the run and everything waits. It runs when an activity has been saved (after its place is looked up, so the place goes with it), at app start, when the app comes to the front and when the phone gets a connection, after the deletes and before the posts. When the server took some, **the feed is asked for again** (your own activity is in it, as long as your profile is not private) and the photos waiting for these activities can go. The body is not gzip-compressed yet (the server takes it either way).

**A finished activity is saved on the phone the moment it is finished** (`features/activity/save.ts`, from the recording store, once the fixes are read): a row in `activities` in the local form (absolute 1e-5 degrees, whole seconds, metres; `activitydetail_v2` `{ enc: 1, tz, breaks }` with the pauses as breaks), `synced = 0` (the loop that sends new activities will pick it up; it is not built yet), the user's id and this install's `downloadid`. It shows in the Activities lists at once, and the details screen reads it like any stored activity. **Its place** (`city`, `state`, `iso`) and weather are found at the start, or from the start point right after it is saved, and kept (`features/activity/conditions.ts`; section 3b); an activity recorded offline gets them on a later pass (app start, the app coming to the front, a connection). Only activities not yet sent are touched. Its **weather** is looked up at the start of the activity, or afterwards when that was offline, and it is not sent until it has its place and weather (section 3b). There is no heart rate yet. (If it could not be saved, or nobody is signed in, the details screen is given what the recording produced, in memory: `features/activity/recorded.ts`.)

**With no route there is no map** (`indoor`): no map, no map controls and no sheet, only the heading under the back, edit and delete buttons, then the note and the sections (Pace, Heart rate, Steps and so on, whichever have data), then Memories. The bar with the name and the section chips takes over once the heading has scrolled up under it. Your own activity is taken to have a map until it has been read from the phone, so an indoor one opens as the map layout for a moment before it settles; someone else's is indoor as soon as its card has no route preview.

What is not connected yet: the photos (`media_v2` and the media upload), and saving an edit of the title or note (it stays on the screen until activities are sent back to the server).

**The inbox.** Watch activities the phone has not seen ([api.md](api.md) section 3):
1. `GET /activities/inbox?limit=20`.
2. Decompress each one and `INSERT OR IGNORE` it with `synced = 1` (the server already has it).
3. `POST /activities/ack` with the ids. The ack is a few bytes, so the phone does not re-upload the whole activity.
4. Repeat until the inbox is empty.

Triggers: app launch, foreground, and after sign-in. A silent push when the watch uploads is optional and can come later.

**A watch activity sent directly by the watch** arrives decompressed and is inserted as it is, with `synced = 0` and `iswatch = 1`, then uploaded by the loop
([watch.md](watch.md) section 3). The phone replies to the watch that it has it.

## 8c. The feed (SQLite)

**Every feed is managed through SQLite.** The Feeds tab never holds posts in memory: the network writes `feed.db` ([schema.phone.md](schema.phone.md), "feed.db") and the screen reads it back through an op-sqlite **reactive query**. Code: `src/data/db/feed.ts` (the file and its SQL), `src/features/feed/repo.ts` (the only writer), `useFeedPosts.ts` (the reactive read), `src/stores/feedStore.ts` (state only: the window, the loading flags).

**Rules**
1. **One writer.** Only `repo.ts` writes the tables. A screen reads; it never writes.
2. **A cache, not a source of truth.** A separate file in Caches, no migrations; a different version is dropped and rebuilt. It can be deleted at any time.
3. **Rowid tables only.** A reactive query hears only about tables with a rowid.
4. **Small columns for the questions, JSON for the rest.** `enddate`, `activityid` and `userid` are columns (order, delete, update); the post is JSON. A change to one field is `json_set` (for example the author's picture).
5. **Reads are bounded and ordered by an index** (`LIMIT ?` on `enddate DESC, activityid DESC`). The window grows by 20 as the user scrolls.
6. **The first page replaces the head.** Posts the server no longer returns, inside the range the page covers, are removed (deleted, or hidden profile). If the new page does **not meet** what is cached (more than a page of new posts), the cache is started again, so there is never a gap in the middle.
7. **Older pages are appended**, with the cursor (`feed_meta.next`) moved on; the last page (no cursor) ends the list.
8. **When it asks:** the first page is asked for **when the app starts, each time it comes to the front, when someone signs in, and on pull down to refresh** (`watchFeed` in `feedStore.ts`, started in `App.tsx`); never on a timer, and not when the Feeds tab is shown again. Nothing is asked while nobody is signed in. The pull-down spinner shows only for a pull by hand (iOS moves the list to make room for it). The ETag keeps a feed that has not changed cheap.
9. **Offline first:** the tab opens with the cache, offline too. A failed request keeps the cache and shows a toast; pull to refresh tries again.
10. **Retention:** 200 posts and 14 days (`pruneFeed`, at app start and after each refresh); the whole-activity cache keeps the 30 last used.
11. **Cleared at sign-out and when the account changes**: it is other people's data.
12. **Your own actions are not in the cache.** Your own shared posts stay in the store for now (to be moved); the author's picture, when you change yours, is written into the cached posts too (`setOwnFeedPicture`) so the feed shows it at once.

**Opening a card's map** lands on Activity details. The card carries only the route preview, so the screen **asks for the whole activity** (`GET /feed/:activityid`, [api.md](api.md) section 11), draws at once from the preview, fills in the charts when the reply comes (it never waits) and shows an error in a toast. The reply is kept in `feed_activities`, so opening it again, offline too, needs no request.

**Photos in a card** keep one copy at 1280 px (sent once, no second size). A card paints the item's `blur` ([format.md](format.md) section 4) behind the picture until it loads: a 4 x 4 grid of colours made by the `MediaPrep` module when the photo is prepared (`blurHex`, [native-engine.md](../native-engine.md) section 9c2), 96 hex digits, drawn by the app (`blurDataUri`). Photos load from `/media/...` with the token and sit in the image cache (7 days).

## 8d. Posts (Home > Share)

A **post** is what the user shares from Home: the **template** (the day's steps, distance or both), **photos and videos**, and **words**. Code: `src/features/posts` (`content.ts` pure rules, `library.ts` make, send, delete, restore, `useOwnPosts.ts` what the feed shows, `watch.ts` when it sends). Shape: [format.md](format.md) section 7; API: [api.md](api.md) section 12; table: [schema.phone.md](schema.phone.md), `posts`.

1. **The rule.** A post needs photos or videos, a title or a description. The Share button is off until one is there; with no photos the labels are "Title" and "Description" and a line says so. A template alone is not a post; a post may have no template.
2. **Making it.** "Share" writes the post to SQLite **at once** with an id made on the phone (its words, the template, the day's totals **as they are at that moment**, and how many files), closes the sheet and takes the user to Feeds. The files follow in the background: each photo and video (as picked, with no figures drawn on) goes through the same preparation as Memories (1280 px WebP; a video 720p, **shown first on the trim screen**, [section 6](#6-preparing-media)) and joins the outbox under the post's id. If **no file could be added and there are no words**, the post is dropped and a toast says so; with words it stays. Some files refused show a toast.
3. **Showing it.** The user's own posts are read from SQLite (not from the feed cache), newest first, merged with the cached posts of others and de-duplicated by id when the server returns them too. A post shows from the server's list of files, **then those still waiting (from the phone's own copy)**, so it looks the same before and after sending; its photos keep the order they were shared in. A post with no words whose first file is not ready is not shown yet. **At app start, signed in or not**, the phone reads which pictures are saved on it (`loadLocalState`), so a post's pictures show from their own files and never need the server's token; the feed and the sending ask the server only when the phone really has a sign-in (`isSignedIn`), since the app's own record of who is signed in can outlive the tokens.
4. **Sending** (`syncPosts`): the deletes first, then each unsent post `PUT /posts/:postid` oldest first, then the upload loop (a file is sent only once its post is on the server). A server that cannot be reached stops the run and everything waits; a post the server **refuses** (400, 409, 422) is marked as handled so it never blocks the ones behind it (it stays on the phone). It runs when a post is made, at app start, when the app comes to the front, when the phone gets a connection, and after a restore (`watchPosts`, `runner.ts`).
5. **The menu, edit and delete.** The three dots are **only on your own posts** (not on other people's posts, and not on activities). They open **Edit post** and **Delete post** (other people's cards have no such menu). **Edit opens the same share sheet** (not a new one), filled in with the post and **starting at its first screen whatever the post has**: the figures and the pictures, then the title and the description; **Save** takes the place of Share (and the share-to-other-apps button is not there). On the first screen the user can change the figures (the change button stays on that screen and offers the templates whose numbers the post has; a post made before both numbers were kept, and shared today, gets today's total for the missing one when the figures are changed (`withTotals`), and one shared on another day is offered only the figure it has; a post made with no figures keeps none unless they change it; the numbers are the day's totals **from when it was shared**, not today's), take pictures off (the x), and add more. Every picture is kept **clean** (no text drawn into it), so the figures shown over it on this screen are the post's and change with the change button. a new photo is added clean too. Nothing changes until **Save** (closing the sheet changes nothing). Save needs photos or videos, or a title or a description, as a new post does. Then (`editPost`) the words and the figures are kept at once and the post is marked unsent, so it is `PUT` again (the server keeps the post's time and its media); pictures taken off leave at once (the server is told, and its S3 files go); new pictures are prepared and sent like a new post's (a video first shows the trim screen). **Delete** asks first ("Delete this post?"), then (`deletePost`) the post and its waiting files go from the screen at once, its saved copies on the phone and its entry in the feed cache go, and the server is told when it can be (DELETE; 404 counts as done), which removes the post and every file of it from S3. A post the server never had is only forgotten. **Until the server is told, the feed leaves the post out** (`usePendingPostDeletes`): the server still has it and would send it back on the next refresh, so a post deleted while the phone is out of reach, or has lost its sign-in, would otherwise come back on reload. A second sheet opens 450 ms after the menu closes (iOS cannot present over a sheet that is still going).
6. **Restore.** After a restore of the activities, the user's own posts come back (`GET /posts`, newest first, page by page) and a post the phone already has is left as it is. Their photos and videos load from the server like anyone's. Signing in as a **different account** clears the previous account's posts.
7. **In the feed.** A post of someone else arrives in the feed with `kind: "post"` ([api.md](api.md) section 11) and is cached in `feed.db` like an activity. **The pictures are clean**: the figures are drawn over each photo and video when the post is shown (`TemplateFigures` in the photo stack, white, bottom left); a post with **no media shows only its title and description** (the figures are kept in the post and show over pictures added later). Words show above the pictures. A post made before this change has its figures drawn into its photos, so they show twice. The figures follow the user's distance unit (km or mi) when drawn.
8. **Sharing outside the app** (the share-arrow button) is separate: it opens the system share sheet and stores nothing. **Only this share draws the figures into the pictures** (captured at the Next step), because other apps cannot draw them; the post to the feed uses the pictures as picked. The edit sheet's header reads **Post** and the post's date and time.
9. **View posts.** The Share sheet's header has **View posts** at the right (as in the Sketch frame "Share - select data 1"; not shown when editing). It closes the sheet and, 450 ms later, opens **Your posts** (`src/screens/myPosts`): every post the user has made, newest first (the phone's own list, so it works offline and a post is there the moment it is made), each as the **same card as the feed** (`FeedPostCard`: words, then pictures with the figures over them, video playing while on screen), each with its three dots for edit and delete (`usePostOptions`, shared with the Feeds tab). With nothing shared it says so.
10. **Not covered yet:** the progress of preparing the files (the post simply appears when its first file is ready), and the clean-up of a post's S3 folder when an account is deleted.

## 8e. The User screen (someone's profile)

Opened from a name on a feed card (and from Settings for your own profile). Everything comes from the server ([api.md](api.md) section 14) and **nothing is stored on the phone**: `useUserProfile` reads `GET /users/:userid` (the last answer is kept in memory so the screen shows at once when opened again) and `useUserFeed` reads their feed a page at a time (`features/users/useUser.ts`). Until the profile answers, the screen shows what the card gave (name, place, picture); a failed read says so under the bio and the tabs stay empty.

- **Header:** their cover (`profilebg`; the app's own cover until they have one), picture, name, "City, Country" and their `about`. There is **no Follow button and no follower counts** yet, and no "Similar people" section: none is shown until the server has them.
- **Stats card:** worked out from the server's totals (`features/users/profile.ts`, pure and tested): Month is this calendar month, Year this calendar year, All the totals; the twelve bars are the last twelve months (Month and Year) or the last twelve quarters (All), each named under the bar (the month's letter, or "Q1"). **Personal bests:** longest distance, longest time and fastest pace (over 1 km or more), only those they have.
- **Recent activity** (Overview): their three latest activities as feed cards. **Photos preview:** their latest pictures from a feed read with `media=true`; a video shows its poster.
- **Activities tab:** their activities, 20 a page (`kind=activity`), grouped by month on the phone (`monthsOf`) with the count and distance of the months loaded; "Load earlier months" reads the next page when every loaded month is shown. A row opens the activity's details (the map is the route preview; the track is not read). The kind (walk, run, ride) is worked out from pace, as everywhere.
- **Photos tab:** `media=true`, 20 posts a page, every picture and video in a masonry grid under its month; the next page loads near the end. Pictures use the token like the feed's.

## 9b. Signing in, and logging out

**Sign in** (`Welcome`): "Continue with Apple" and "Continue with Google" open the provider's own sheet (`services/signInProviders.ts`: `@invertase/react-native-apple-authentication`, `@react-native-google-signin/google-signin`, configured with the app's iOS OAuth client; the Apple capability and Google's URL scheme are in the iOS project). The provider's ID token (and for Apple the authorization code, the nonce, and the name the first time) go to `POST /auth/login` ([api.md](api.md) section 1b); the server says who the user is. Then, as before, `GET /profile` decides whether the user is new (404: the setup steps) or back (welcomed), and the restore starts. **A new user starts with the name the provider gave** (Google's token; Apple's `fullName`, which Apple tells only the first time, so it is sent to the server at once), else the start of the e-mail, else "You"; it is marked unsent with the setup's details, so the first send makes the profile. **A new user starts with an empty profile**: the profile kept on the phone (picture, cover, about, details) belongs to whoever used it before, so it is reset at sign-in (a user who has a profile gets theirs from the server instead); a picture or cover that cannot be loaded shows the initials and the default cover, never a blank. Closing the sheet says nothing; a refused token (401) or a server without the provider (503) says so in a toast. A debug build also lists test users, who sign in through `dev-login`.

**Logging out** (`features/auth/logout.ts`): the server is told first (`POST /auth/logout` with this device's refresh token; the Keychain is cleared), then Google's grant on the phone and the kept Apple user id are dropped and the app goes to Welcome. Others' cached posts are cleared; the user's own activities stay (section 10). It needs the server: offline, the user stays signed in and Settings says "Connect to the internet to log out", because a token left alive on the server is not a log out. Nothing else ends a sign-in: a token the server refuses signs the user out with a notice and nothing wiped (`expired`).

**The user removes the app from their Apple ID** (Settings > Apple ID > Sign in with Apple): Apple then reports the grant as `revoked` (`getCredentialStateForUser`, and an event while the app runs). The phone checks at start, whenever the app comes to the front and on the event (`features/auth/appleCredential.ts`), and **signs the user out the normal way even when the server cannot be reached** (`logOut({ force: true })`); Welcome says why (`APPLE_REVOKED_MESSAGE`) and signing in with Apple again returns to the same account and data. Only `revoked` acts: `notFound` happens on a simulator or a new phone, and an unreadable state is no reason to sign anyone out.

**Profile pictures:** none is taken from Google or Apple. A user of the old app whose `profilepic` is the provider's `https` address keeps it as it is: the phone shows their initials until they choose a picture, and the server never treats it as a file to delete (`docs/data/production-checklist.md` has the optional script to copy them into the bucket).

## 9. Profile and location

**Edit profile (name, about, gender, date of birth, height, weight)** is kept on the phone at once and sent to the server with `PUT /profile` ([api.md](api.md) section 7). The profile store marks what is unsent (`unsent: { userid, fields, rev }`); `syncProfile` (`features/profile/sync.ts`) sends the **current value of every unsent field** (the name as given name and first word, surname the rest; gender `nonBinary` as `other`, not stated as none; the birth date as midnight UTC; height and weight to one decimal; a cleared field as `null`) and removes the mark only if nothing was edited while it was on its way. It runs after an edit, at app start, when the app comes to the front and when a connection arrives (the sync loop, first). A value the server refuses (400) is let go, a busy or unreachable server is tried again. What the server says at sign-in never undoes an unsent field (`keepUnsent`). **A new user's setup** (gender, height, weight, date of birth) is marked unsent when it finishes, so the first send **makes their profile on the server**; offline it goes when there is a connection (visibility waits for the profile).

**Visibility (Edit profile > Privacy > Profile visibility)** is public or private. The choice is kept in the profile store at once and marked unsent (`visibilityUnsentFor` = the user's id); `syncVisibility` (`features/profile/visibility.ts`) sends `PUT /profile/visibility` ([api.md](api.md) section 7c) and clears the mark, and tries again at app start, when the app comes to the front and when a connection arrives (the sync loop, before the deletes). While it is unsent, what the server says at sign-in does not undo it. A change made while one is on its way stays marked, so the newer choice is sent too. When the server has it, the feed is read again (your own activities come or go with it).

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
1. The user confirms with the **6-digit code e-mailed to the account's address** (`DeleteAccountSheet`: a code is sent when the sheet opens, checked as it is typed, a wrong one shakes the boxes; resend after 30 seconds; "We couldn't send the code" when it cannot be sent). The e-mail address shown is the account's; the server sends to the one it has ([api.md](api.md) section 8b).
2. "Delete my account" opens the deleting screen, which calls `DELETE /account` with the confirmed code (kept in memory only). **If the server cannot finish (no connection, S3 not answering), the screen says so and offers "Try again" and "Back"; nothing is cleared on the phone and nothing is lost.** On 204 (or a 401 on a repeat: the tokens no longer work, which is what a deleted account looks like):
3. Tell the watch (`accountDeleted` over WatchConnectivity). Wipe SQLite, MMKV, the Keychain (including the encryption key, but not the device id) and the prepared media files (built: the activities, photos and videos, profile pictures, feed, posts and the restore's progress; the tokens; Google's grant on the phone and the kept Apple user id; and the profile). Discard anything native still holds. Go back to the sign-in screen.
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
