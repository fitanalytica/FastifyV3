# Watch

What the watch app stores and does. The activity: [format.md](format.md). The requests: [api.md](api.md). The server: [server.md](server.md).
The phone: [phone.md](phone.md). The watch is native (SwiftUI), so its sync and its compaction are written in Swift to the same spec, with the shared tests
(README section 3).

## 1. The watch's table

The table, its indexes and checks: [schema.watch.md](schema.watch.md). It has the phone's columns, with two flags in place of `synced`: `server_synced` and `phone_synced`.
Rows are stored in the decompressed form, like every row on a device. The watch keeps its own newest 50 watch activities (section 4).
It does not store activities recorded on the phone.

## 2. Token from the phone

1. The phone calls `POST /auth/watch-token` with its own access token ([api.md](api.md) section 1). The server makes a separate device for the watch and returns its own tokens.
2. The phone passes them to the watch over WatchConnectivity (once). The watch keeps them in its own Keychain. The phone does not keep a copy.
3. After that the watch refreshes with the server directly. A refused refresh means the watch was unpaired or the account was deleted: it wipes its data (section 6).

## 3. Sending an activity

A watch activity is stored with both flags 0, then sent two ways at once:

1. **To the server, compressed:** `POST /activities/batch` with the watch's token. The server inserts it with
   `tosend = 2`, and the watch sets `server_synced = 1` on the reply.
2. **To the phone, decompressed:** WatchConnectivity `transferUserInfo` (queued, survives a restart), or
   `transferFile` for a big one. The payload carries the watch's `downloadid` and `iswatch = true`. The phone inserts it
   as it is, with `synced = 0` and no decompression, uploads it through its normal loop (which compacts it; the server keeps
   `tosend` at the lower value, 1), and replies to the watch, which sets `phone_synced = 1`.

**A watch row is finished when `server_synced = 1` or `phone_synced = 1`.**
- Server has it, phone does not: the phone gets it from its inbox ([phone.md](phone.md) section 8).
- Phone has it, server does not: the phone uploads it.
- A dead phone or a dead watch is covered either way, and the same `activityid` stops any duplicate.

Failures retry like the phone's loop ([phone.md](phone.md) section 4): 5 s, 15 s, 1 min, 5 min, then every 15 min.

## 4. Install and restore

On install, `GET /wearable/v3/activities?limit=50`, once, no paging ([api.md](api.md) section 4). The server returns only the watch's own activities, the newest 50; the watch cannot ask for the phone's. The rows are stored with `server_synced = 1`.
The watch keeps its own newest 50 only. It may drop older rows, but **never a row where both `server_synced` and `phone_synced` are 0**.
Phone activities are never sent to the watch.

## 5. Deleting an activity

Same as the phone ([phone.md](phone.md) section 5): `delete_pending`, then `DELETE /activities/{activityid}` with the watch's token, then the row is removed.
The watch also tells the phone with a `deleted { activityid }` message (queued). A message arriving from the phone is handled the same way.

## 6. What the watch never does

- It never changes the profile, and its location is never used for the profile location. Its activities still carry their own route.
- It never uploads media.
- It never stores phone activities.
- On a refused token refresh or an `accountDeleted` message it wipes its data and its Keychain.
