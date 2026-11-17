# FastifyV3

The v3 sync API (Fastify 5, TypeScript ESM, Postgres reader/writer pools). Runs on its own port (3003) and shares nothing with the v2 `FastifyApp` or `api`.

- Specs: [docs/data/README.md](docs/data/README.md) is the index (ground rules, open items). The server side: [api.md](docs/data/api.md), [server.md](docs/data/server.md), [schema.pg.md](docs/data/schema.pg.md), [format.md](docs/data/format.md), [performance.md](docs/data/performance.md).
  `phone.md`, `watch.md` and the `schema.phone/watch` files are kept here only because the others link to them.
- Local database: `sh docs/data/dev-db/reset.sh` (localhost only; drops and rebuilds `fitanalytica_dev`).
- `cp .env.example .env.local`, then `npm run dev` (port 3003) and `npm test`.

## Layout (the same as FastifyApp)

```
src/
  server.ts            starts the app (listen) and nothing else
  app.ts               build(): error handlers, plugins, routes. Tests call this with app.inject
  routes/
    index.ts           /health, then phoneRouter, wearableRouter, storeRouter
    phone/index.ts     registers v3 under the prefix phone/v3        (a v4 is one more line here)
    phone/v3.ts        every phone v3 endpoint in one flat list: UNSECURED, then SECURED
    wearable/          the same for the watch: prefix wearable/v3, only what the watch calls
    store/             App Store / Play Store (none yet)
  schemas/             request shapes (TypeBox): the body, query and params of each endpoint. Fastify checks them; types/http.ts derives the types from them
  controller/
    common/v3/         endpoints the phone and the watch share, one file each, exporting xxxV3 (refreshtoken, me, activitiesbatch, deleteactivity)
    phone/v3/          phone only: logout, devlogin, activities (the restore: all of the user's activities), inbox, ack
    wearable/v3/       watch only: activities (the watch's own newest 50, enforced on the server)
  services/            the work, by domain: auth/ (checkAccess, loginDevice, refreshAuthTokens, logoutUser, devLogin, tokenUtils),
                       activities/ (validate, upsert, batch), profile/ (getProfile, updateLocation), location/ (countries: the ISO code to country name list), health.ts
  hooks/               authenticate.ts: adds fastify.authenticate(kind), kind = 'phone' | 'watch' (tablet counts as phone; chrome and mac are refused)
  plugins/             index.ts loads them in order; db.ts = reader and writer pools
  config/env.ts        the only place that reads process.env; typed; a missing variable stops the start with its name
  errors/              AppError.ts, handler.ts (v2 reply shape; logs to apperrors), codes.ts (the error codes the app acts on)
  types/               auth.ts, activity.ts, http.ts (request and reply bodies), fastify.ts (our fields on Fastify's types)
tests/                 mirrors src: routes/{phone,wearable}/, services/, errors/, config/, helpers/ (app + account + fixtures);
                       architecture.test.ts enforces the layer rules below
docs/data/             the specs
```

A router file is a list: `fastify.post('/activities/batch', { ...isAuth, schema: { body: BatchBodySchema } }, activitiesBatchV3)`. `isAuth` is `{ onRequest: [fastify.authenticate('phone')] }`
(the watch's router uses `fastify.authenticate('watch')`; each refuses the other kind of token with 403 `WRONG_DEVICE`).
It is `onRequest`, not `preHandler`, so a bad token is refused before the body is read.

Rules: a router has no logic. A controller is one or two lines: it passes `req` to a service. A service does the work (checks, SQL) and knows nothing about `req` or `reply`.
A request that does not match its schema is a 400 `BAD_REQUEST` before the controller runs. (Fastify's `coerceTypes` is `true`, not its default `'array'`, which would wrap a lone value into a list.)
Types used in more than one file live in `types/`. Error codes are constants from `errors/codes.ts`, never loose strings.

These are checked by `tests/architecture.test.ts`, which fails the build when a layer reaches where it should not:
routes import only controllers and schemas (and schemas import only TypeBox); controllers import only services and types (and no package but `fastify`), have no SQL, no `throw`, and at most 20 lines;
services never touch `req` or `reply`; only `config/env.ts` reads `process.env`; every controller export ends in its version (`…V3`).
If one of these fails, the code is in the wrong layer: move it, do not loosen the test.

## Versions (v4 later)

The phone's address is `https://apps.fitanalytica.com/phone/v3` and the watch's `.../wearable/v3`. A new version is a new folder beside the old one, and the old one is never edited to make room:

1. Add `routes/phone/v4.ts` and one line in `routes/phone/index.ts` (`fastify.register(phoneRouterV4, { prefix: 'phone/v4' })`).
2. An endpoint that did not change: import the same controller (`controller/common/v3/me.ts`) in `v4.ts`.
3. An endpoint that changed: a new controller in `controller/phone/v4/`, calling the same service when the logic is the same, or a new service when it is not. v3 keeps working until the apps that use it are gone.
4. `fastify.authenticate(kind)` is version-independent. Change it only if v4 changes how a token is checked, and then add a second function beside it, not an edit.
5. Tests for v4 go in `tests/routes/phone/v4/`.

## Run

`cp .env.example .env.local`, then `npm run dev` (port 3003), `npm run typecheck` (source and tests), `npm run build`.
**Tests run in their own database, `fitanalytica_test`, never in `fitanalytica_dev`.** Make it once: `DB=fitanalytica_test sh docs/data/dev-db/reset.sh`, and create `.env.test` (a copy of `.env.local` with both database URLs ending in `fitanalytica_test`, `DEV_LOGIN=true` and no `DEV_USER_*`). `npm test` loads `.env.test`, and `tests/setup.ts` refuses to start unless both URLs name a database ending in `_test`.
Why: the tests change and delete data, and a mutation check (breaking a rule on purpose to see a test fail) runs the broken code for real. Run in the development database, which holds the imported users, one of them rewrote everyone's location. `fitanalytica_dev` is for `npm run dev`, the app and the imported data.
`.env.local` also maps the dev-login providers to local users for the app: `DEV_USER_APPLE=<userid>` and `DEV_USER_GOOGLE=<userid>` (the app's "Continue with Apple / Google" in a debug build signs in as them). A provider with no mapping signs in as the fixed dev user, who has no profile: the app reads that as a **new user** and goes to the setup steps. Restart the server after changing it. `dev-login` also takes a `userid` to sign in as exactly that user (it must be in the local database; an unknown one is a 400), which wins over the mapping: the debug build's Welcome screen uses it for its three test-user links, so those need no mapping and no restart. Today Apple is mapped to a user with a long history (`e0779e72`, 2,010 activities) and Google to a user who has just set up: `docs/data/dev-db/seed-new-user.sql` makes (and resets) one with login data, a gender, height, weight and birth date and nothing else, no activities, no steps, no tokens (`DEV_USER_GOOGLE=ae0e0001-0000-4000-8000-000000000001`). To try the setup steps themselves (a user with no profile at all), comment `DEV_USER_GOOGLE` out: an unmapped provider signs in as the fixed dev user, who has none.
Real data for local testing (local only, safe to re-run): `python3 docs/data/dev-db/import-activities-csv.py <export>.csv ...` `python3 docs/data/dev-db/import-userinfo-csv.py <export>.csv` and `python3 docs/data/dev-db/import-userlogin-csv.py <export>.csv` (in any order: the first two create a placeholder `userlogin` row where one is missing, and the userlogin import fills it in). The CSVs hold real users' routes and personal details: keep them out of the repo and delete them after. The userinfo importer prints counts only, never a value.
