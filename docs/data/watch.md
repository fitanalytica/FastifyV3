# Watch

What the watch app stores and does. The activity: [format.md](format.md). The requests: [api.md](api.md). The server: [server.md](server.md).
The phone: [phone.md](phone.md). The watch is native (SwiftUI), so its sync and its compaction are written in Swift to the same spec, with the shared tests
(README section 3).

## 1. The watch's table

The table, its indexes and checks: [schema.watch.md](schema.watch.md). It has the phone's columns, with two flags in place of `synced`: `server_synced` and `phone_synced`.
Rows are stored in the decompressed form, like every row on a device. The watch keeps its own newest 50 watch activities (section 4).
It does not store activities recorded on the phone.

## 2. Install and token from the phone

0. **When the watch app is installed and first opened, it calls `POST /wearable/v3/download`** (public, no token) with its own download id and device id: the server makes the watch's own `downloads` row (no owner yet, `device_type = watch`) with the place of its IP address, like the phone's ([api.md](api.md) section 1d). **Not built on the watch yet** (the Swift side has no networking; the route is ready).
1. The phone calls `POST /phone/v3/auth/watch-token` with its own access token and the watch's `deviceid` and `downloadid` ([api.md](api.md) section 1d). The server makes the watch's own tokens, **and at that moment sets the user's id on the watch's `downloads` row** (making the row if step 0 never happened); the phone's row says a watch is paired.
2. The phone passes them to the watch over WatchConnectivity (once). The watch keeps them in its own Keychain. The phone does not keep a copy.
3. After that the watch refreshes with the server directly. A refused refresh means the watch was unpaired or the account was deleted: it wipes its data (section 6).

**The message contract** (phone side built: `src/features/watch/tokenExchange.ts`; **watch side not built**). The watch asks, the phone answers; the phone never sends its own tokens.

```
watch -> phone   (sendMessage, it waits for the reply)
  { type: "REQUEST_WATCH_TOKEN",
    deviceid:   <the watch's OWN device id, a UUID kept in its Keychain; never the phone's>,
    downloadid: <the watch's install id, a UUID: the same one it sent to POST /wearable/v3/download>,   // optional: the server makes one
    device?: "Apple Watch", platform?: "ios",
    deviceInfo?: { os, appVersion, model, code, manufacturer, timezone, region } }

phone -> watch   (the reply)
  { ok: true,  accessToken, refreshToken, userid, downloadid }       // the WATCH's own tokens
  { ok: false, error: "NOT_SIGNED_IN" | "OFFLINE" | "BAD_REQUEST" | "REFUSED" | "FAILED" }
```

- **`NOT_SIGNED_IN`**: nobody is signed in on the phone (or its own sign-in was lost): the watch shows "Open fitAnalytica on your iPhone and sign in". **`OFFLINE`**: the phone cannot reach the server: ask again later. **`BAD_REQUEST`**: the ids are not UUIDs, or the watch's device id is the phone's. **`REFUSED`**: a token that is not a phone's. **`FAILED`**: anything else (reported by the phone).
- The phone asks the server `POST /phone/v3/auth/watch-token` with the phone's own token ([api.md](api.md) section 1d); **the moment the server makes the watch's tokens it sets the user's id on the watch's `downloads` row** and marks the phone's row as having a watch paired, so the watch sends no "linked" message. One request at a time for a device id (a watch that asks twice gets the same answer).
- The tokens cross only the paired devices' encrypted channel, and are never written to a log or a report.
- **What the watch must do** (not built): make and keep its own device id and download id in its Keychain; call `POST /wearable/v3/download` when first opened; ask for the token when it has none; keep the tokens in its Keychain; refresh with `POST /wearable/v3/auth/refresh`.

**When the watch's refresh token is refused, and the phone is locked, off or far.** A refused refresh is **not** "unpaired": it only means the server no longer accepts that refresh value (the server accepts the previous value for 30 days after a rotation, so a lost reply is not a refusal). The watch must **not wipe** at once: it may hold activities nobody has received yet (section 3: never drop a row with both flags 0). The recovery, which never needs the phone to be awake at the moment the watch asks:
1. **The watch keeps its identity** (device id, download id, the account's `userid`) and drops only the tokens. It goes on recording and storing activities; they reach the phone through WatchConnectivity (section 3), which needs no watch token.
2. **It asks the fast way first, the queued way if that cannot be done:** a message that waits for a reply (`sendMessage`: the answer comes straight back, only if the phone app is in reach); **if the phone is not in reach, a queued transfer** (`transferUserInfo`, at most one a day waits in the phone's queue; asking both at once would only make the phone replace the tokens it just gave): `{ type: "REQUEST_WATCH_TOKEN", deviceid, downloadid, userid, requestId (new each time), reason: "refresh_refused", ... }`). The queued one is the one that matters: **WatchConnectivity keeps it on the watch until the phone can take it (the phone is off or out of Bluetooth range), and it survives the watch app restarting.** Delivered to a phone whose app is terminated, it **launches the app process in the background, but only its native part runs** (see step 3).
3. **The phone takes it whenever it can.** **Native (always, even in a background launch with the phone locked):** the transfer is written into the inbox before anything else. **JS (only when the app's JavaScript is running):** if signed in, it has the server make the watch's tokens (`POST /auth/watch-token`, which replaces the watch's tokens for that device id) and **queues the answer back** (`{ type: "WATCH_TOKEN", requestId, deviceid, ok, accessToken, refreshToken, ... }`), and only then acknowledges the request. The phone's own tokens are in the Keychain as "after first unlock": a **locked phone can still make the call when JS is running**; before the first unlock after a restart it cannot, and the request waits. With no network the request stays and is tried again when the app comes to the front and every minute while it runs.
   **When JS is running:** (a) the phone app is open, or was in the background a moment ago (its process is alive: the delivery resumes it for a few seconds and JS handles the request, even with the screen locked), and (b) at the next start and each time the app comes to the front. **When it is not:** the app was terminated: iOS launches the process in the background for the transfer, but **React Native starts in the scene (`SceneDelegate`), and a background launch has no scene, so no JS runs**: the request waits in the inbox until the user next opens the app. That is the known gap: the watch stays on "Waiting for your iPhone" until the user opens the phone app. **Closed by a notice (built):** when a token request lands in the inbox and nobody can answer it (JS is not listening, the app is not on screen) the phone posts the local notification **"Open fitAnalytica to finish linking your watch"**; opening the app starts JS, which finds the request in the inbox and answers it, and the notice is removed. It is posted only if notifications are **already allowed** (a background launch cannot ask): the phone app asks for them on Home, once a session, as soon as a watch is paired with its app installed. Not done: the native side making the call itself (not done: the phone's access token lives in JS memory and a second refresher would race with JS over the rotating refresh value).
4. **The watch adopts the answer whenever it arrives** (it may be hours later) and carries on. Only the newest request of a watch is answered (older ones are dropped); the watch uses the newest tokens it has, matched by `deviceid`.
5. **When the answer is a refusal, the watch knows why:** `NOT_LINKED` (the user removed it in Linked devices) or `ACCOUNT_CHANGED` (the phone is now signed in as someone else): **only these two** make the watch wipe its data, after it has tried to hand its unsent activities to the phone. `NOT_SIGNED_IN`: nobody is signed in on the phone: the watch shows "Sign in on your iPhone" and waits (the request stays queued). `OFFLINE`/`FAILED`: ask again later.
6. **What the watch shows meanwhile:** "Waiting for your iPhone" with the time of the request; nothing is lost.
**The phone has the new tokens and the watch is dead** (off, battery empty, far away, its app deleted or reset). The server has already replaced the watch's tokens for its device id, so the old ones no longer work, but nothing is lost:
- **The answer is queued, not sent:** `transferUserInfo` keeps it until the watch app can take it, and the phone says "tokens sent" (not "delivered") for that watch. When the watch is back and takes them, WatchConnectivity tells the phone (`onUserInfoFinished`) and the phone says "delivered".
- **The phone keeps no copy** and makes tokens **once** per request: if they cannot be queued yet (the session is not ready) they are kept **in memory** for ten minutes and queued again **without asking the server again**, which would replace them every minute. If no watch is paired at all, no tokens are made and the request waits.
- **A newer request replaces an older answer:** tokens for the same watch still waiting in the queue are cancelled when new ones are queued (the old ones are invalid), so a watch that was dead for weeks never holds old tokens. The watch adopts the newest it has, matched by `deviceid`.
- **Self-healing:** if the queued tokens are lost (the watch app was deleted, the watch reset or replaced) the watch asks again as soon as it can (it has no valid tokens), and the phone makes new ones; a replaced watch has a new device id and links as a new device. The only residue is a `usertokens` row on the server that the watch never used.
- **What the phone shows** (Linked devices, not built): the watch, with "tokens sent" and the time while it has not taken them ("waiting for the watch"), and "delivered" once it has.

- **What cannot be done:** a watch whose refresh is refused and that never gets to talk to the phone again cannot sign itself in (it holds no Apple or Google credential, by design): it keeps working offline and its activities still reach the phone; the account is safe, because the phone is the only way back in. A deleted account or a removed watch is the same: the phone says so.

## 3. Sending an activity

A watch activity is stored with both flags 0, then sent two ways at once:

1. **To the server, compressed:** `POST /activities/batch` with the watch's token. The server inserts it with
   `tosend = 2`, and the watch sets `server_synced = 1` on the reply.
2. **To the phone, as a queued transfer:** WatchConnectivity `transferUserInfo` (queued, survives a restart): `{ type: "WATCH_ACTIVITY", activity: <the wire form> }`. **It carries the same wire form as the server batch** (format.md section 2: the coordinates and times as increments, `iswatch: true`, the watch's own `downloadid`, `dtgraph`, an empty `media_v2`), not the decompressed one: one encoder (`WatchActivityCodec`, the same rules as the phone's `encodeActivity`) serves both, the transfer is smaller, and the phone reads it with the code that reads the server's inbox (`decodeActivity`). The phone checks it (`parseWatchActivity`: a UUID id, whole dates in order, a start point on the Earth, a track whose arrays have one length and a detail with it), **stores it with `synced = 0` and `iswatch`** (a repeat is ignored: the id is the key), uploads it through its normal loop (which compacts it; the server keeps `tosend` at the lower value, 1), then **queues back `{ type: "WATCH_ACTIVITY_ACK", ids: [activityid] }`**, and only then acknowledges the transfer in its own inbox. The watch sets `phone_synced = 1` on the acknowledgement. **A transfer too big (over 100 KB of JSON) is not sent this way**: such an activity reaches the phone through the server's inbox, as it does anyway. A transfer not acknowledged after six hours is queued again (`phone_sent_at`).

**A watch row is finished when `server_synced = 1` or `phone_synced = 1`.**
- Server has it, phone does not: the phone gets it from its inbox ([phone.md](phone.md) section 8).
- Phone has it, server does not: the phone uploads it.
- A dead phone or a dead watch is covered either way, and the same `activityid` stops any duplicate.

Failures retry like the phone's loop ([phone.md](phone.md) section 4): 5 s, 15 s, 1 min, 5 min, then every 15 min. The server request is plain JSON (no gzip: the watch has no compressor in its libraries, and the route takes up to 8 MB), 20 activities at most; the answer is read item by item (`created` and `exists` set `server_synced`; `deleted` removes the row; `invalid` writes `sync_error` and stops that row; an item missing from the answer is tried again). **Built** (`WatchActivities.swift`, `WatchActivityStore.swift`, `WatchActivityLogic.swift`): nothing records on the watch yet, so nothing calls `WatchActivities.add` (step 3); the whole path is tested without it (`native-tests/swift/watchactivity.swift`, `__tests__/watchActivities.test.ts`) and has not run on a watch.

**Recording on the watch** ([native-engine.md](../native-engine.md) section 9f): a real workout (HealthKit session and builder, GPS, heart rate, `CMPedometer` steps). The route passes the phone's `FixFilter`, so distances agree; a pause starts a new line (a `break`); heart rate is kept every 5 s or on a change of 3 bpm; under 100 m is "Too short to save"; **outdoors** the finished activity becomes a row (`iswatch`, `activitydetail_v2 = { enc: 1, tz, breaks }`, the track in absolute values, no weather or place: the watch has neither) and is stored and sent as above; **indoors** only Health gets the workout (no route, no row: as on the phone). The workout, its route and heart rate are also saved to **Health on the watch** (shared with the phone's Health). Weather and the city are not filled in for a watch activity. **The Activities list and the detail page are drawn from the watch's table** ([native-engine.md](../native-engine.md) section 9f): the kind is read from the pace (it is not stored), the page shows only what the row has (no weather or place on a watch activity), calories and heart-rate zones are estimates.

## 4. Install and restore

On install, `GET /wearable/v3/activities?limit=50`, once, no paging ([api.md](api.md) section 4). The server returns only the watch's own activities, the newest 50; the watch cannot ask for the phone's. The rows are stored with `server_synced = 1` (**built**: `WatchActivities.restoreOnce`, after the watch has its tokens; the flag `watch.activitiesRestored` makes it once, a wipe clears it; a row already on the watch is left as it is).
The watch keeps its own newest 50 only. It may drop older rows, but **never a row where both `server_synced` and `phone_synced` are 0**.
Phone activities are never sent to the watch.

## 5. Deleting an activity

Same as the phone ([phone.md](phone.md) section 5): `delete_pending`, then `DELETE /activities/{activityid}` with the watch's token, then the row is removed.
The watch also tells the phone with `{ type: "WATCH_ACTIVITY_DELETED", activityid }` (queued), once the server has answered 204 or 404. A message arriving from the phone is handled the same way: **deleted on the phone** (`deleteActivity`, for an activity with `iswatch`) it tells the watch, which removes the row; **deleted on the watch** the phone deletes it too (without telling the watch back) and its own loop tells the server. **Built** on both sides (`WatchActivities.delete`, `features/watch/watchActivities.ts`).

## 6. What the watch never does

- It never changes the profile, and its location is never used for the profile location. Its activities still carry their own route.
- It never uploads media.
- It never stores phone activities.
- A refused token refresh does **not** wipe (section 2): it drops the tokens and asks the phone; the watch's steps and activities stay. It wipes its tokens, its ids and what it keeps of the account only on the phone's answers `NOT_LINKED` or `ACCOUNT_CHANGED`, or an `accountDeleted` message.

## 7. Steps, and what the phone tells the watch

**The watch counts its own steps** (`WatchStepsCollector`: `CMPedometer`, the last seven days and then live, Motion & Fitness on the watch; no Health needed) and keeps them in **its own SQLite** (`WatchStepsStore`, `ios/WatchApp/`), one row a day, **primary key `dtgraph`** (the local date as midnight UTC: the same key as the phone's `steps_daily`):

| Column | Meaning |
|---|---|
| `dtgraph` | the day, the primary key |
| `steps`, `distance` (m), `ascend`, `descend` | the watch's own counter; **each of the four keeps its own highest value for the day** (a lower number changes nothing; when any number grew, `watch_synced` goes back to 0) |
| **`watch_synced`** | **1 only when the phone has acknowledged this row as it is now**; 0 for a row that is new, changed, or not acknowledged yet |
| `sent_steps`, `sent_distance`, `sent_ascend`, `sent_descend`, `sent_at` | the version (all four numbers) last queued for the phone and when: what the watch **sent**, which is not the same as what the phone **has** |

**Every row that is not acknowledged goes to the phone, whether or not Health is shared, and however many there are**: as queued transfers (`transferUserInfo`, so they arrive even if the phone was off or far) `{ type: "WATCH_STEPS", rows: [{ dtg, stp, dis, asc, dsc }] }`, **in transfers of 500 rows** (a transfer is a message; there is no limit on the number of transfers). What is due:
- a row **never sent**, or **changed since it was sent** (any of its four numbers is not the one sent): at once;
- a row sent and **not acknowledged** after six hours although it did not change: sent again (the transfer may have been lost, or the phone gone for the day);
- **today's row** only if never sent or last sent five minutes ago or more, and at once when the watch app goes to the background (it moves all day).

**The phone answers with the days it took**: after it has saved the rows it queues back `{ type: "WATCH_STEPS_ACK", rows: [{ dtg, stp, dis, asc, dsc }] }`, **the day (`dtgraph`) and the four numbers it took** (as the watch sent them), and only then acknowledges the transfer in its own inbox. The watch sets **`watch_synced = 1` for each day whose four numbers are still the ones acknowledged**: a day that moved on meanwhile (any number higher) is left at 0 and goes again as it is now. A day is acknowledged **whether the watch's number won or not** (the phone has seen it); a row the phone left out as unbelievable is not acknowledged (it is retried and reported). Rows acknowledged and older than 60 days are dropped from the watch; **a row the phone has not acknowledged is never dropped.** A database made by an earlier build is migrated: its `synced` becomes `watch_synced`, all 0 again.

**The phone reconciles** ([phone.md](phone.md) section 11, `features/watch/watchSteps.ts`): the phone's own pedometer, the watch and Health (when its permission is given) are three sources of the same days, **today included**; for each `dtgraph` **each of steps, distance, floors up and floors down keeps its own highest value** (a source with more steps never lowers another's distance or floors; floors climbed after the last step still count); a lower number changes nothing. A row the phone cannot believe (a day that is not a day, an absurd number) is left out and the others are kept. With Health not given, it is the phone and the watch; the watch's rows are taken either way.

**What the phone tells the watch** (`features/watch/watchContext.ts`): one **application context** (the latest wins; it reaches the watch even when its app is not running): `{ v, apiOrigin, units, voice, goal: { stepcount }, demog: { heightCm, weightKg, gender }, steps: [last 7 days, reconciled], plan }`. **`plan` is today on the running plan** (`features/watch/watchPlan.ts`, the same day as the banner in Add activity, from `planRunFor`): `{ kind: "run"|"first"|"adjusted", minutes, label, coach }` (`coach` is the phone coach's plan JSON: blocks with pace targets), `{ kind: "rest", minutes }` (the recovery walk), `{ kind: "done", summary, next? }`, `{ kind: "paused", daysLeft }`, or `null` with no plan; every kind also carries **`week`** (the week of the plan, from 1) and **`legs: { done, total }`** (the plan's legs behind you and all of them) for the Plan widget. It is resent when a plan is started or the run days or the pause change. `apiOrigin` is where the watch calls its own routes (the Mac in a debug build). It is sent at start, when the user changes units, voice coach, step goal or profile (after two seconds), when the app comes to the front, and every five minutes for the steps, and only when it changed. **Not sent yet:** challengers, calories and distance goals, today's pedometer (it is in `steps`).

**What the watch shows of it** (`WatchDayLogic.swift`, `WatchToday.swift`; [native-engine.md](../native-engine.md) section 9f): the **Steps page** draws today's count from the watch's own row and **a chart of the last days** (five days ago to today, then tomorrow as the average of the five days before today, out of the screen on both sides so the line is flush with its edges), with kcal, km and active time under it; the **widgets** read a day written to the shared app group (`watch.today`: today's figures, steps by hour, a typical day, against yesterday, the last seven days, the week). Calories and active minutes are **estimates** (the pedometer has neither: 0.53 kcal per kg per km with the context's weight, 70 kg when unknown; steps at 100 a minute).

**The plan on the watch's Start page** (`WatchPlanLogic.swift`, `WorkoutModel.startPlan`, `PlanPill`): between play and Settings, a blur capsule with the bolt and the run's length ("30 min"; **only on a day with a run to start**: none on a rest day, while paused, or without a plan; green "Done" once today's run is done). It starts today's run as the banner's Start does on the phone: a Run aiming at its minutes, with the plan's coach (pace targets; kept in the checkpoint, so a resumed run goes on with it); Play still starts a plain activity: the plan is a banner, never a goal mode.

**Not built:** Challengers still show sample data (`WatchSampleData.swift`); the Plan widget is fed from the plan now (`WatchToday` writes `nextRun`: today's run or walk with its minutes, "Run done", or "Running paused", the week and the legs).
