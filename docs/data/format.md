# Activity format

The shape of an activity, on the phone, the watch and the server. Where it is stored: [phone.md](phone.md) section 2,
[watch.md](watch.md) section 1, [server.md](server.md) section 1. How it travels: [api.md](api.md) section 2.

## 1. Columns

| Column | Meaning |
|---|---|
| `activityid` | UUID created on the device that records it. The same value on the watch, the phone and the server. |
| `userid` | Owner. On the server it comes from the token, never from the request body. |
| `startdate`, `enddate` | Epoch seconds, UTC. |
| `duration`, `stepcount`, `distance` | Seconds, steps, metres. Computed from the full track before it is stored. They travel as values and are never recomputed on restore. |
| `lat`, `lon` | Start point in degrees, sent with 5 decimals as doubles. Used for search and for `geom`. The server returns the exact value from `geom`, which is the **start of the compact lat/lon arrays** (section 2). |
| `downloadid` | The `downloads` row of the device that recorded the activity (a phone, or a watch). Set once, never updated on a repeat. See [server.md](server.md) section 2. |
| `iswatch` | True if recorded on the watch. Set once and never updated, including when the phone uploads it. |
| `temp`, `realfeel`, `humidity`, `wind`, `uvi`, `iso`, `weathericon`, `weather`, `city`, `state`, `aqi` | As in the Postgres schema. |
| `description`, `media_details`, `device` | As in the Postgres schema. |
| `activitydetail_v2`, `activitybpm_v2`, `media_v2` | The three new columns for the new data format. See section 3. |
| `activitylat`, `activitylon`, `activitytimenow`, `activityelevation`, `activitydistance` | The track, as arrays. See section 2. |

## 2. The track arrays

The arrays keep the form they have today, so old and new rows read alike:

| Array | In the stored (local) form | On the wire (compact) |
|---|---|---|
| `activitylat`, `activitylon` | Whole numbers in **1e-5 degrees** (5 decimals, about 1.1 m), absolute | **Increments**, first element `0`, start from the row's `lat` / `lon` |
| `activitytimenow` | Epoch seconds, absolute | **Increments** in seconds, first counted from the row's `startdate` |
| `activityelevation` | The actual value at each point, in **metres**, as today | The same (no change) |
| `activitydistance` | Metres. **In the old rows it is the step between one point and the next, not a running total** (measured on 600 real activities: its sum is about 0.96 of the distance, and only 4 of 600 arrays rise steadily). What a new row holds is not decided; the phone does not use this array, it works the distance along the route out from the coordinates | The same (no change) |
| `activitybpm_v2` | `{ "t": [epoch seconds], "v": [bpm] }` | `t` as increments from `startdate`, `v` as actual values |

Each array has one entry per recorded point (same length as `activitylat`), or is null if there is none. `activitybpm_v2` is its own series with its own times, one pair per kept
sample. The watch keeps a sample about every 5 seconds, or sooner when the value changes by 3 bpm or more. It is not tied to the location points, so heart rate stays accurate while standing still.

Old rows already store latitude, longitude and time as increments, in 5 decimals, so they need no change. Only the first element of a coordinate array differs from what you might expect: it is `0`,
and the start comes from `lat` and `lon`. (`activityelevation` and `activitydistance` are in metres, and with `activitybpm` they hold actual values.)

**Local form (decompressed).** Absolute values, in every row, as JSON text. The coordinates are whole numbers in 1e-5 degrees.

**Wire form (compact).** Latitude, longitude and time are increments. The increment is taken from the previous *stored (rounded)* value, so errors never add up.

```
lat column            12.97160            (5 decimals)
local   activitylat : [1297160, 1297162, 1297165, 1297164]
wire    activitylat : [0, 2, 3, -1]

startdate             1731480000
local   activitytimenow : [1731480000, 1731480001, 1731480003]
wire    activitytimenow : [0, 1, 2]
```

Arrays that are null stay null. Decompress with a running sum, starting from `lat` and `lon` (`round(lat * 1e5)`) for the coordinates and from `startdate` for the times.
`decompress(compact(x)) == x` must hold exactly, so the start point must be exact. The `lat` and `lon` columns are 4-byte `REAL` and cannot be used for that: they hold only about 7 digits, which is
not enough to give back the last decimal for longitudes above 128 degrees east (Japan, Australia), and the whole route would shift by a unit. The exact start point already exists in **`geom`**, which stores
two doubles. So for a new row the server returns `lat` and `lon` read from `geom` (`ST_Y(geom)`, `ST_X(geom)`) when it sends the row to a device, and the app uses those as the start. The `lat` and `lon`
columns stay as they are, for search and display. (Old rows are read with their `REAL` start, as today.)

## 3. The three new columns

The old columns keep their old data. New activities use three new columns. (The names are placeholders:
change them if you prefer others.)

| New column | The old column | What changes |
|---|---|---|
| `activitydetail_v2` (JSON) | `activitydetail`: one value per point, 1 (slow walk) to 5 (fast run) | An object (below) |
| `activitybpm_v2` (JSON) | `activitybpm`: one bpm for each location update | Its own series with its own times (section 2) |
| `media_v2` (JSON) | `media`: an array of webp names (`uuid1.webp`, `uuid2.webp`, ...) | A list of items (section 4) |

`activitydetail_v2`:

```json
{ "enc": 1, "tz": 19800, "breaks": [412, 980] }
```

- `enc`: format version, `1` for this spec. Anything else is rejected by the client until it is updated.
- `tz`: seconds east of UTC when the activity was recorded. Every device uses it to decide which local
  day the activity belongs to, so the streak comes out the same after a reinstall.
- `breaks`: point indexes where a pause happened *before* that point. A map line is never drawn across
  a break, and RDP runs on each piece separately.

The old 1 to 5 value for each point is **not stored** in the new format: the device works it out from the
speed between points whenever it draws the route.

**Reading old activities.** An activity whose `activitydetail_v2` is empty is in the old format. The track columns `activitylat`, `activitylon` and `activitytimenow` are already
increments in old rows, so they need no conversion. The app converts the rest when it reads it: media names become photo items without a size, and the old heart rate is turned into
`t` and `v` using the point times.

## 4. Media items

`media_v2` is a list of items. Item keys follow the app's `MediaItem` (`type` is `photo` or `video`):

```json
[ { "type": "photo", "value": "6f1c…2e.webp", "dimension": [1536, 2048] },
  { "type": "video", "value": "a90d…71.mp4", "dimension": [720, 1280], "duration": 12.4, "poster": "a90d…71.webp" } ]
```

| Key | Meaning | In the app today |
|---|---|---|
| `type` | `photo` or `video` | `MediaItem.type`, same values |
| `value` | The file name in the bucket, with no address in front, so the address can change. The extension says the format. | The app builds `source: { uri: base + value }` |
| `dimension` | `[width, height]` in pixels of the file as shown (after rotation), so a card can reserve its space | Not in `MediaItem` yet; add it |
| `duration` | Video only, seconds | Not in `MediaItem` yet; optional |
| `poster` | Video only: the still shown until the first frame | `MediaItem.poster` (video) |
| `blur` | A 4 x 4 grid of colours (16 x 6 hex digits = 96 characters) the card paints while the picture loads. Optional. Made on the phone | `MediaItem.blur` |

Old rows hold `["uuid1.webp", "uuid2.webp"]` (and the richer `media_details`). They are read as photos.

How a file is prepared on the phone: [phone.md](phone.md) section 6. How it is uploaded: [api.md](api.md) section 6.
Where it lives: [server.md](server.md) section 6.

## 5. Step history (`walkdata`)

One row per user. It keeps today's totals in plain columns and the history in compact arrays. (Per-day rows were tried before and dropped: the table grew too fast, values repeated, and these encodings could not be used.)

**A day** is a `dtgraph`: a calendar date written as that date at midnight UTC, so it is a multiple of 86400 and the same label in every time zone (defined in [README](README.md) section 5).

**Plain columns, always today** (or the latest day with data): `dtgraph` (the day), `stepcount`, `distance` (metres), `ascend` (floors up; **floors down are not sent or kept by v3**), the records `max_steps`, `max_steps_date`,
`max_distance`, `max_distance_date`, and `steps_goal` (default 10000), and the previous day for yesterday's leaderboard: `yesterday_dtgraph` (always `dtgraph - 86400`), `yesterday_stepcount`, `yesterday_distance`, sent by the phone and stored as received.

**History arrays, completed days only**, oldest to newest, one entry per day that has data:

| Column | Entry |
|---|---|
| `stepcount_json` | steps that day |
| `distance_json` | metres that day |
| `ascend_json` | floors up (**there is no `descend_json`**: floors down are kept for today only, in the plain `descend` column; no coordinates either) |
| `dtgraph_json` | the days, as deltas (below) |
| `iso_json` | the country of each day, run-length encoded (below) |
| `history_base` (new column) | the day the deltas were encoded against |

**`dtgraph_json`** (`encodeDeltas`, `decodeDeltas`): element `i` is the number of days from day `i` to day `i + 1`, and the last element is the number of days from the last day to `history_base`. A number above 1 is a
gap of days with no data. Decoding starts from `history_base` and walks back.
**`iso_json`** (`rleEncode`, `rleDecode`): `[["IN",328],["TR",15],["IN",53]]` is 328 days in India, then 15 in Turkey, then 53 in India. A day whose country the phone does not know is sent with the phone's **current** country (the phone's table keeps it empty); `ZZ` only when the phone has no country at all (the world map leaves `ZZ` out). Decoded, it has one country per entry of the other arrays.
**The world map** is the sum of the steps per country after decoding. The phone computes it from its own table; the server never does.

**Which form a row is in.** A row with `history_base` set is the new form: the arrays hold **completed days only**, and today comes from the plain columns. A row with `history_base` empty is the old form: the arrays include today
and the deltas are against `dtgraph`. Readers handle both.

Why `history_base` exists: the arrays are now sent once a day, but `dtgraph` moves on every new day. Without the base stored beside the arrays, a `dtgraph` that has moved on would decode the older arrays to the wrong dates.

## 6. The route preview (`route_preview`)

A small version of an activity's route, so a feed card can draw its map without the track. Column `activities.route_preview jsonb` ([schema.pg.md](schema.pg.md) section 2); NULL for an activity with no track.

```json
{ "p": [lat0, lon0, dlat1, dlon1, dlat2, dlon2, ...] }
```

- Whole numbers in **1e-5 degrees**: the first point is absolute, every other is the **step** from the point before (the same idea as the track arrays, section 2). Always an even count of at least 4, so at least two points.
- Made by **simplifying the route with RDP** (Ramer-Douglas-Peucker) at a tolerance of **6 m**, at most **120 points**. When the simplified route has more than 120 points, the 120 most significant are kept (the start and the end always).
- **The phone makes it when it uploads an activity** (it already has the same RDP for its maps: `previewFromPoints`) and the server only checks the shape (`bad_route_preview`) and stores it. It is **only ever filled in, never replaced** (`COALESCE`), so a repeat upload cannot change it.
- For activities the phone never sent it (the old app's), the server fills it once with `npm run backfill:preview` in the v3 repo. **Run it on production before the feed goes live.**
- The phone reads it with `routeFromPreview` and draws it as the route on the card; the details screen uses it too until the whole track arrives.

## 7. Post content (`posts.content`)

What a post says, as JSON. The shape is checked by the API when a post is written and stored as it is; the server never reads inside it.

```json
{ "v": 1, "template": "steps_distance", "steps": 7240, "distance": 5123, "dtgraph": 1763251200, "title": "Morning", "description": "A slow one." }
```

| Key | Meaning |
|---|---|
| `v` | The version of this shape; always `1` for now. |
| `template` | Optional: `steps`, `distance` or `steps_distance`. The figures the post shows. Without it the post is words and media only. |
| `steps` | The **day's steps at the moment of sharing** (a snapshot: the day's total goes on growing, the post does not). Kept with any template, so the template can be changed later (Edit) without asking for the day's totals again; a post made before that may have only the number its template showed. |
| `distance` | The day's distance in **metres** at the moment of sharing. Kept like `steps`. |
| `dtgraph` | The day those numbers belong to, a date as midnight UTC (README section 5). |
| `title` | Up to 120 characters. |
| `description` | Up to 2000 characters. |

Rules: a template needs the numbers it shows (the API checks); a post with no photos or videos needs a title or a description. **How it is shown:** the pictures are kept clean and the figures are drawn over each photo and video when the post is shown, so changing the template changes them at once; a post with no photos or videos shows only its words (the figures are kept in the content, so they show if pictures are added later). The photos and videos are in a separate column, `media_v2` (section 4), because the upload loop changes them while the author may be editing the words.
