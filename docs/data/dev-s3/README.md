# Local S3 (MinIO)

The server reads and writes media through the S3 API ([server.md](../server.md) section 6). On a development machine that is **MinIO**, a stand-in with the same API, so nothing touches AWS and uploads and deletes are safe.

```sh
brew install minio                      # once
sh docs/data/dev-s3/run.sh              # its own terminal: S3 on :9000, console on :9001 (minioadmin / minioadmin)
node docs/data/dev-s3/seed.mjs         # buckets + a sample photo (varied shapes) for each photo the local database mentions
```

Add to `.env.local` (the production server sets only `S3_REGION`; its credentials come from its role):

```
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
```

- Buckets, as in production: `activitees` (`<activityid>/<file>`) and `fitpy` (`<file>`). Names can be changed with `S3_BUCKET_MEDIA` and `S3_BUCKET_PROFILE`.
- The data is in `~/.fitanalytica-minio`, outside the repo. Delete that folder to start again.
- **From the simulator** the address in a signed link is `localhost:9000`, which is the Mac for the iOS simulator. The Android emulator reaches the Mac at `10.0.2.2`, so there set `S3_ENDPOINT=http://10.0.2.2:9000` in `.env.local`.
- The tests (`npm test`) never connect: they only check the signed addresses.
