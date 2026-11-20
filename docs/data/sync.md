# The unified sync call

Status: **steps 1 to 3 and the restore built, 2026-11-20**: the server's envelope and the sections `walk`, `activities`, `inbox`, `profile`, `device` and `state`, and the phone's `syncNow` with gzip and all those sections; **the old phone routes are removed** ([api.md](api.md) section 0b). Not built: streak and plan sections (and their part of the restore), the watch's own call. Agreed in chat: fewer server calls; send in one go, answer in one go.
Principle: **the phone makes as few requests as it can, each carrying everything that changed, and each answer carries everything the phone needs.** At scale the cost is requests (auth check, connection, rate-limit tick, a flaky network failing each one), not bytes.

## 1. One route

`POST /phone/v3/sync` (the watch later gets `POST /wearable/v3/sync`, the same shape with the sections the watch has). Authenticated like any phone route; the body is JSON, **gzip** (the server already unpacks it; the phone starts to send it, see section 7).

```jsonc
// request: only the sections that changed. A sync with nothing to send and nothing to ask is not made.
{
  "up": {
    "walk":       { "today": { ... }, "history": { ... } },          // the bodies of api.md section 10
    "activities": { "delete": [ "id", ... ], "send": [ { ... } ] },   // up to 20 each; the batch of api.md section 2 (compact form)
    "inbox":      { "ack": [ "id", ... ], "pull": true },             // the watch's activities the phone has taken / asks for the next
    "profile":    { "put": { ... }, "visibility": { "hidden": true }, "location": { ... } },   // api.md section 7, only what changed
    "device":     { ... },                                            // api.md section 1d, only what changed
    "state":      { "platform": "ios", "catalog": "<version>", "ads": "<version>" }   // a read: the versions the phone holds
    // streak, plan: when they exist on the server
  },
  "restore": { "activities": "<cursor or absent>" }          // present only while restoring (section 5; not built)
}
```

```jsonc
// response: always HTTP 200 once the user is known; each section has its own result
{
  "results": { "walk": { "ok": true }, "activities": [ { "id": "...", "ok": true }, ... ], "profile": { "ok": false, "code": "BAD_REQUEST" } },
  "down": {                                   // only what was asked for (a `pull`, a `state` read), and, for `state`, only the parts whose version differs
    "state":   { "v": "f00ba4...", "entitlement": {}, "catalog": {}, "ads": {}, "protection": {} },
    "inbox":   [ { ... } ],                   // the watch's activities waiting for the phone
    "walk":    { ... }, "streak": { ... }, "plan": { ... }, "profile": { ... }     // on a restore, or when another device changed them
  },
  "more": false,                              // true: send again at once (a restore page, or an upload that did not all fit)
  "next": { "activities": "<cursor>" }        // restore only
}
```

## 2. Rules

1. **One request at a time** from the phone's sync loop ([README](README.md) ground rule 8), and a request only when a section is dirty, on a trigger (app front or back, sign-in, a change settling), or on the timer (5 minutes while the app runs; today's steps still wait for their five minutes or the background).
2. **Per-section results.** A section fails alone: the others in the same request are saved and answered. Each section is **idempotent** (sending it twice is safe), so a lost answer is retried with the same content. The phone clears a dirty flag only for a section answered `ok`.
3. **HTTP errors are for the whole request**: 401/403 (`TOKEN_EXPIRED` refresh then retry once, `LOGOUT`), 400 (the envelope is not valid), 413 (halve the `activities` and retry), 429/5xx (back-off, same body). A section's own problem is in `results`, never an HTTP status.
4. **Sizes are capped by the server** and told in `more`: `activities` up to about 1 MB of compact JSON (and 20 items) per request; the rest goes in the next request at once. Nothing is silently dropped.
5. **Down sections carry a version where they have one.** The phone puts the versions it holds in the section's own request (`state`: `catalog`, `ads`); the server answers only what differs. A section that is only a read (`state`) is asked for with its request as `up.state`. An idle sync is not made at all, so this replaces the polls (`/me/state`, the inbox).
6. **Each section checks its own part of `up`.** The route validates only the envelope (`up` is a free map), so a section that does not match its shape answers `{ ok: false, code: "BAD_REQUEST" }` and the others still run; a name the server does not have answers `UNKNOWN_SECTION`. **Each section is its own piece of work on the server.** The controller stays a thin line; `services/sync/` has a registry of sections (`walk`, `activities`, `profile`, `device`, ...), each a file with `apply(up)` and, for the sections that give something back, `read(up)`. Adding a section is adding a file, not a route.
7. **The user is from the token**; nothing in the body names a user. The location headers (api.md section 1c) apply to the whole request, as now.

## 3. What is in it, and what stays out

| In the call | Why |
|---|---|
| walk (today, history), activities (new, edited, deleted), the inbox and its ack, profile, device, streak, plan, `state` | Background data the user does not wait for. |
| **Out: sign-in, refresh, logout, delete account** | They decide who the request is; they come first and answer at once. |
| **Out: media (presign, commit, then S3)** | The bytes go to S3, not through the API; the commit is the one small call per file. |
| **Out: purchases, redeem** | The user is waiting for the result on screen; it must not queue behind a sync. |
| **Out: feed, other people's profiles and posts, challengers, weather** | User-driven reads that change with what the user opens; cacheable GETs, one call per screen. |

## 4. The walk section

`walk.today` and `walk.history` are exactly the bodies of `PUT /walk/today` and `PUT /walk/history` ([api.md](api.md) section 10; no floors down, a day with no country goes with the current one). The rules do not change: history is sent when a completed day is new or changed and goes **first**; if it fails, today waits (the phone sends today in the next request). One request can carry both, so a day that closes costs one call, not two. `results.walk` is `{ ok, code?, history?: "ok" | code, today?: "ok" | code | "WAITING" }`: `WAITING` is today held back because the history in the same request was refused (nothing of today is written); a refused today does not undo a history saved in the same request.

## 5. Restore in one shot

**Built** (`services/sync/restore.ts`, `readWalk.ts`; the phone's `features/sync/restorePage.ts`, `features/steps/walkRestore.ts`). A new phone or a new sign-in sends `POST /sync` with **`restore`**: `{ walk?: true, activities?: { before?, limit? } }`. The first request asks for both: the answer's `down.restore` has **`walk`** (the user's `walkdata` row: today's plain columns and the arrays of completed days, as stored, `null` when there is none) and **`activities`** (a page `{ activities, next, total }`, newest first, `total` on the first page only). The next requests ask only for activities with the cursor `before` (the `next` of the page before). `more` is true while there is a next page. A page is up to 200 activities (the phone's ask, at most 300) **and is cut to fit about 1.5 MB** (the server asks again for fewer when a page is bigger); the JSON comes from the database and is not parsed on the way. A full account of 2,000 activities is about 10 requests (and fewer with the size cut working in the other direction on small activities), not the 41 of paging by 50. The restore is resumable (the cursor is kept after each page) and the step history is asked for once per account. The sections of the same call run first (`up` is sent, then `restore` is read). A `restore` that does not match (a limit of 0 or over 300, a cursor that is not one) answers `results.restore = { ok: false, code: "BAD_REQUEST" }` and nothing else is refused.

**Not in it:** `GET /profile`, which stays its own call because the sign-in decides on it (404 means a new user, who goes on to the setup steps) before any screen can be shown; `state` (its own section, asked at the start). The **streak and plan** come with their sections (`restore.streak`, `restore.plan`), when they exist. The watch's `GET /activities` is its own route. `GET /walk` was never built: the restore covers it.

## 6. Failure and retry, in one table

| What happens | The phone does |
|---|---|
| Offline, timeout, 5xx | Keep every dirty flag; retry later with back-off; the same content. |
| 401 `TOKEN_EXPIRED` | Refresh, repeat the request once. |
| 413 | Send half the activities. |
| A section `ok: false` | Keep that section dirty and report once (`code` says why); the other sections are done. |
| Answer lost after the server saved | The next request repeats the section; the server's upsert makes it a no-op. |
| App killed mid-request | Same as a lost answer. |

## 7. Gzip on the phone

The body is compressed with a small JS library (`fflate`, about 8 KB) and sent as bytes with `Content-Encoding: gzip`; the arrays are repetitive numbers and shrink several times. It needs one device check (that axios on React Native sends the raw bytes). The server side exists.

## 8. How it gets built (nothing breaks on the way)

1. **Built.** Server: the envelope (`schemas/sync.ts`, `POST /phone/v3/sync`, 8 MB body limit), the registry (`services/sync/runSync.ts`: one line and one file per section), the `walk` section (`services/sync/walk.ts`, calling the services behind `PUT /walk/*`), and tests (an empty call, both bodies in one request, today or history alone, a refused history holding today, a refused today keeping the history, a bad or unknown section failing alone, auth). `down` is `{}` and `more` is false until the sections that read exist. The 413 for activities comes with that section.
2. **Built.** Phone: `syncNow(reason)` (`features/sync/syncNow.ts`): a section is `{ name, collect(ctx) }` and `collect` returns what is dirty with a `commit(result)` that records what the server accepted (so **nothing is marked as sent until the answer says so**); nothing dirty means no request; one at a time (a second call gets the running one's result); `more` sends again at once, at most 5 times; a failure of the whole request keeps everything dirty and the next trigger sends it again; a section the server refuses is reported once and stays dirty. `watchSync` runs it at start, on sign-in, on foreground, on background (forces today) and every 5 minutes. The walk section is `collectWalk` (`features/steps/walkSync.ts`). Gzip: `fflate` in `data/api/gzip.ts`; a body of 1 KB or more is sent as an exact `ArrayBuffer` with `Content-Encoding: gzip` and an explicit `Content-Type`; smaller ones as text. **Checked against the server in a test; not yet on a device** (that React Native's HTTP stack sends the bytes unchanged).
3. **Built.** The sections moved in one at a time: `activities` (send and delete: `delete` is applied before `send`, as the loop always did), `inbox` (`pull` reads up to 20 oldest first, the 21st is `more`; `ack` is applied before the pull of the same request), `profile` (`put`, `visibility`, `location`, in that order, each failing alone), `device`, then `state` (a read; the catalogue and the ad rules come whole only when the version differs). Server: one file each in `services/sync/`, registered in `runSync.ts` with an `apply` and, for the reads, a `read`; the phone: `collectActivities`, `collectInbox`, `collectProfile`, `collectDevice`, `collectState`. The old phone routes were removed, and their tests now make the same calls through the sync call (`tests/helpers/viaSync.ts`).
4. Build streak and plan **as sections from the start**, never as their own routes.
5. **Built.** The restore (section 5); it grows with the streak and plan sections.
6. The old phone routes are gone; the watch's own routes (`/wearable/v3/...`) stay until the watch has its own call.

## 9. Open points

1. **The path and the versions** (`/phone/v3/sync`; section versions as 12-hex hashes like the catalogue): proposed, easy to change.
2. **The caps**: 1 MB / 20 activities per request is a first guess; measure with a real account.
3. **`GET /me`** is removed (neither app used it; the tests check a token with the sync call, `tests/helpers/viaSync.ts`). **The watch** gets its own `/wearable/v3/sync` with `activities`, `walk` (its steps, instead of the transfers) and `ack`; to design when the watch's activities go to the server.
