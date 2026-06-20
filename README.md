# respawn-social-backend

One job: **proxy + cache the [IGDB](https://www.igdb.com) game API** so we never
exceed IGDB's strict rate limit (4 requests/second, shared across _all_ users).

The front-end (the [Respawn Svelte app](https://tangled.org/tidaltheory.io/respawn-social-web),
which also handles all AT Protocol / Bluesky login) talks to this service for
game data — never to IGDB directly (IGDB blocks browser requests, and the API
credentials must stay server-side).

---

## Why this exists (the short version)

A browser **cannot** call IGDB: IGDB rejects cross-origin browser requests and
requires a secret token. And IGDB's rate limit is _global_ to our credentials —
if 50 users searched at once, 50 browser calls would instantly blow the limit.

So this backend is the **single choke point**: it holds the token, paces all
outgoing calls under the limit, and caches everything in Postgres so popular
games are fetched from IGDB essentially **once, ever**.

```
[ Front-end ] --HTTP/JSON--> [ THIS SERVICE ] --rate-limited--> [ IGDB ]
                                   |
                              Postgres (game cache + token)
```

---

## Project layout

```
src/
  index.ts            App entry: HTTP server, CORS, route wiring, error handlers.
  config.ts           Loads + validates env vars at startup (fails fast if wrong).
  logger.ts           Structured logging (pretty in dev, JSON in prod).

  db/
    schema.ts         All database tables (the source of truth).
    client.ts         The Postgres connection pool + Drizzle client.
    migrate.ts        Applies SQL migrations (run on deploy).

  igdb/               === The "don't hammer IGDB" core ===
    token.ts          Fetches/caches/refreshes the Twitch (IGDB) access token.
    client.ts         The rate-limited request queue (the 4 req/s gate) + retries.
    data.ts           Read-through cache: getGame() / searchGames() with
                      stale-while-revalidate + request dedup.

  lib/
    single-flight.ts  Helper: dedupe identical concurrent requests.

  routes/
    games.ts          GET /games/:id, GET /games/search
```

Most files have inline comments explaining the backend concept they implement.

---

## Prerequisites

- **[Deno](https://deno.com) 2+** (runs the TypeScript directly — no build step)
- A **PostgreSQL** database (local or hosted)
- **Twitch app credentials** for IGDB:
  create an app at <https://dev.twitch.tv/console/apps> (Client Type:
  _Confidential_) to get a Client ID + Secret. IGDB authenticates via Twitch.

---

## Setup

```bash
deno install                  # installs npm deps into node_modules
cp .env.example .env          # then fill in your Twitch client id + secret
```

---

## Local development

Postgres runs in Docker; the app runs natively for fast watch-reload.

```bash
docker compose up -d db       # start Postgres (creates the `respawn` database)
deno task db:migrate          # apply the SQL in ./drizzle (creates the tables)
deno task dev                 # run the API in watch mode
```

The default `DATABASE_URL` in `.env.example`
(`postgres://postgres:postgres@localhost:5433/respawn`) already matches the
compose service, so no extra config is needed. (Host port is **5433** to avoid
clashing with any native Postgres already running on 5432.)

> If you change `src/db/schema.ts`, regenerate the migration with
> `deno task db:generate`, then run `deno task db:migrate` again.

To stop the database: `docker compose down` (add `-v` to also wipe the data).

---

## Running (production)

```bash
deno task start               # run once (no watch)
```

The server listens on `PORT` (default 3000).

> **Deno permissions:** the tasks grant explicit access flags
> (`--allow-net`, `--allow-env`, `--allow-read`, `--allow-sys`). Deno denies
> network/env/filesystem access unless granted — this is its security model.

---

## Lint & format

Linting is [oxlint](https://oxc.rs) and formatting is oxfmt (configured in
`oxlint.config.ts` and `oxfmt.config.ts`), run via Deno's npm support.

```bash
deno task lint                # check with oxlint
deno task format              # format with oxfmt
```

---

## Endpoints

| Method | Path                          | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/health`                     | Liveness check.                              |
| GET    | `/games/:id`                  | A single game by IGDB id (cached).           |
| GET    | `/games/search?q=zelda`       | Search games by title (cached).              |

Quick check:

```bash
curl localhost:3000/health
curl "localhost:3000/games/search?q=hollow%20knight"
```

---

## How the caching works (in plain terms)

- **Single game** (`getGame`): look in Postgres first. Fresh? return it (no IGDB
  call). Stale? return the old copy _immediately_ and refresh in the background
  ("stale-while-revalidate"). Missing? fetch from IGDB once and store it.
- **Search** (`searchGames`): cached by normalized query for a few hours.
- **Rate limit**: every IGDB call goes through one queue capped below 4 req/s, so
  even a traffic spike just queues up instead of getting rejected (HTTP 429).
- **Dedup**: if many users request the same uncached thing at once, only one
  IGDB call is made; the rest await it.

---

## Deployment notes

- Built for a **long-lived container** (Fly.io / Railway), _not_ pure serverless
  — the in-memory rate limiter and token cache need a persistent process.
- A `Dockerfile` is included (based on the official `denoland/deno` image; Deno
  runs the TypeScript directly, so there's no compile step).
- Set all `.env` values as platform secrets. Set `ALLOWED_ORIGINS` to your
  front-end's real origin(s).
- Single instance is assumed. The in-memory rate limiter and token cache
  (`src/igdb/client.ts`, `src/igdb/token.ts`) live in the process; to run
  **multiple** instances you'd want a shared cache/lock (e.g. Redis).

## Note on IGDB usage terms

IGDB is free for **non-commercial** use under the Twitch Developer Agreement.
A commercial product needs a partner agreement (which also unlocks webhooks /
data dumps — a great future upgrade to keep the cache warm with near-zero calls).
