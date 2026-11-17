# Before production

Everything that must be done, run or decided before v3 goes live. **Keep this list current**: add a line when a change needs something outside the code (a schema change, a script, a setting, a clean-up), and tick it when it is done on production. Status: `[ ]` to do, `[x]` done on production.

## 1. Database (Postgres)

Run the scripts in `dev-db/` **in order** on production, with the same statements; each was written for it (`CONCURRENTLY` indexes run **outside a transaction**, constraints are added `NOT VALID` and then validated). Take a backup first.

- [ ] **Check the real data first** ([schema.pg.md](schema.pg.md) section 8, "What the real data shows"): the counts of `tosend` and `iswatch` (old watch rows left at `tosend = 2` would flood the inbox), and the second check listed there.
- [ ] `04-migration-v3.sql`: the new `activities` columns and the `tosend` check, the three activity indexes, `userinfo.geo_source` and **`geom` made nullable**, the `walkdata` columns and index, `usertokens` (**one row per device**: drops `unique_applegoogle_device`; adds `prev_refresh_token` and `prev_changed_date` for the refresh grace, and its index). The "housekeeping drops" it leaves out come last, after the app is live.
- [ ] `05-feed-v3.sql`: `activities.route_preview` and the `activities_feed` index.
- [ ] `06-posts-v3.sql`: the `posts` table and its two indexes.
- [ ] `07-account-deletion-v3.sql`: the `account_deletion_codes` table (the e-mailed code for deleting an account).
- **Do NOT run `08-billing-standin.sql` on production**: it is a local stand-in for the old app's `paymentstore`, which production already has.
- [ ] **Subscriptions and deleting an account (a rule to keep):** a user who has bought a subscription keeps their `userinfo` row (billing needs it); everything else of theirs is deleted. The test is a row in `paymentstore` for the user. **Before the deletion goes live, check on production:** (1) the foreign keys of `paymentstore`, `validatereceiptstore` and the other billing tables: if one points at `userlogin` with `ON DELETE CASCADE`, deleting the login **deletes the billing rows too**: change it (to `SET NULL` or no action, or copy what billing needs first); (2) which tables really count as "bought" (only `paymentstore` is tested today); (3) whether a kept row should lose more personal data (`about`, `fname`, `lname`, the place) after the period billing must keep it: the picture and cover are cleared already.
- [ ] Account deletion also needs `quotations` (the old table whose key blocks deleting a login) to be handled where it exists: it is deleted first, inside the transaction.
- [ ] `usertokens.deviceid` is set by the app (`DeviceInfo.getUniqueId()`) instead of generated: check the login code writes it ([schema.pg.md](schema.pg.md) section 4).
- [ ] Anything added after this was written goes here too (a new `dev-db/NN-*.sql`, **and** `reset.sh`).

## 2. Scripts to run once

- [ ] **`npm run backfill:preview`** on production **before the feed goes live**: makes the route preview of activities the phone never sent ([format.md](format.md) section 6).
- [ ] **Profile pictures that are an `https` address** (the old app stored the sign-in provider's link in `userinfo.profilepic`): decided to leave them as they are (the phone shows the initials until the user picks a picture) and the server must never try to delete or serve such a value (guard to build with the sign-in work). **Optional script (TODO):** download each link, store it in the bucket as a WebP and set the file name; skip dead links.
- [ ] A **clean-up job for orphan files** in S3 (a failed delete after a media change, a post or activity removed; [server.md](server.md) sections 3 and 4). Not written.

## 3. Server settings (environment, never committed)

- [ ] `DEV_LOGIN` must be **false** (or unset) on production: `POST /auth/dev-login` answers like an unknown route only then.
- [ ] `REFRESH_GRACE_SECONDS` **unset** (30 days). It is `120` in local `.env.local` only, for testing.
- [ ] S3: only `S3_REGION`, signed with the server's role. No `S3_ENDPOINT`, no MinIO keys. The buckets (`activitees` for media, `fitpy` for profile images) and their CORS and lifecycle rules.
- [ ] Weather: **real** `WEATHER_API` and `OPEN_WEATHER_API` keys. The ones used locally are **test keys**: replace them, and never put keys in a file that is committed. Without both, `POST /weather` answers 503 and finished activities are held back from the feed ([phone.md](phone.md) section 3b).
- [ ] **Sign in with Apple and Google** (built): `APPLE_CLIENT_ID` (`com.fitanalytica`; the audience of Apple's tokens), `APPLE_TEAM_ID`, `APPLE_KEY_ID` (or `APPLE_SIGNIN_KEYID`) and the Sign in with Apple Key's `.p8` as `APPLE_SIGNIN_PRIVATE_KEY_BASE64` (or `APPLE_PRIVATE_KEY_PATH`, or the PEM in `APPLE_PRIVATE_KEY`; kept out of git; **not** the `APPLE_IAP_*` subscription key) **are needed to keep Apple's refresh token (and so to revoke it)**; without them login still works but nothing can be revoked. `GOOGLE_CLIENT_IDS` (comma-separated: the iOS OAuth client, and the web client if one is used) is **required** or Google login answers 503. Optional: `LOGIN_RATE_LIMIT` (default 20 tries a minute per address).
- [ ] Apple Developer: the "Sign in with Apple" capability on the App ID `com.fitanalytica` and a Key for it. Google Cloud: the iOS OAuth client of the app (its reversed id is already the URL scheme in `Info.plist`) and the consent screen **published** (not in testing, which limits users).
- [ ] **E-mail (the deletion code):** `SNS_ARN` (the topic the old API publishes mail to) and `SNS_REGION` (us-east-1), and the server's role with `sns:Publish` on it. Locally, put the topic in `.env.local` **and** AWS credentials in the environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`); without `SNS_ARN` and with `DEV_LOGIN=true` the code is only written to the server's log. The consumer of the topic must send `body` as plain text.
- [ ] The server's role needs `s3:ListBucket` and `s3:DeleteObject` on **both** buckets (`activitees` and `fitpy`) for the account deletion (it lists each activity's and post's folder, then deletes).
- [ ] The database roles and connection strings (`PG_WRITER_URL`, `PG_READER_URL`, `PG_SSL`); the reader may lag the writer (the code reads the writer where it matters).

## 4. Code still to build

- [x] **Sign in with Apple and Google:** the login route (`POST /auth/login`) with token verification, Apple's token exchange (its refresh token is kept in `usertokens.apple_refresh_token`), the phone flows, logout through the server, a revoked Apple credential signs the user out, no picture is taken from Google. **Still to do on a real device** (section 5) **and with real keys.**
- [x] **Delete account** is built ([api.md](api.md) section 8b): the e-mailed code, every file of every activity and post and the pictures deleted from S3, Apple's grant revoked, every row deleted in one transaction. **To check on real systems:** a real e-mail through the topic (`SNS_ARN`), a real deletion with files in S3, and the Apple revoke with a real refresh token (section 5).
- [ ] **A limit per user in the feed**, so one busy user cannot fill it ([server.md](server.md) the feed).
- [ ] **Compress the activity upload** (`POST /activities/batch` is not gzip-compressed yet).
- [ ] **Activity type** (walk, run, ride) is worked out from pace and not stored; indoor activities are not saved by the engine yet.
- [ ] **Android:** Google Sign-In (an Android OAuth client with the app's SHA-1), Apple sign-in on Android (a Services ID and a web flow), the Kotlin port of the native engine ([native-engine.md](../native-engine.md)).
- [ ] **Rate-limit and abuse:** the login route is limited per address only; consider a limit per `sub` and monitoring of `LOGIN_REFUSED` in `apperrors`.
- [ ] Apple's **server-to-server notifications** (consent revoked, account deleted) as a webhook: optional.
- [ ] Profile editing sends name, about, gender, date of birth, height and weight; `timezone` and `hideprofile` are not part of `PUT /profile` (visibility has its own call).
- [ ] Follow, followers and "similar people" on the User screen: nothing exists yet (the screen hides them).

## 5. Not yet checked on a real device

Written and unit-tested, never run on a phone: **deleting an account** (the e-mail, the files in S3, Apple's revoke, signing out every device), **Sign in with Apple and Google on a real device** (Apple's sheet and nonce, Google's iOS client and the token's audience, a first sign-in with the name, removing the app from the Apple ID), logout, the reactive queries of the feed (`reactiveExecute`), the native video trim and its frames, most screen animations and shared-element transitions, the weather and place capture at the start of an activity, posts with video, the User screen, profile and visibility sync, the soft-spring map controls.

## 6. After launch

- [ ] The "housekeeping drops" of `04-migration-v3.sql` (columns and indexes the old app no longer needs), once the old API is switched off. **The old API (v2) is never changed.**
- [ ] Retire `dev-login` code or keep it behind its flag.
