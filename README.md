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

This service used to be a rate-limited proxy in front of IGDB. It no longer is.
With Data Partner access we mirror IGDB's daily dumps into Postgres, derive the
titles we actually serve, and answer every request locally — no IGDB call, no
rate limit to respect, and search that understands our own fold.

```
IGDB dumps (nightly) ──▶ [ canonical mirror ] ──▶ derive ──▶ [ titles ]
                                                                  │
                              [ Front-end ] ◀──HTTP/JSON──────────┘
```

The one exception is a game id we have never mirrored, which is fetched live,
mirrored, and derived on the spot.

---

## Project layout

```
src/
  index.ts            App entry: HTTP server, CORS, route wiring, error handlers.
  config.ts           Loads + validates env vars at startup (fails fast if wrong).
  logger.ts           Structured logging (pretty in dev, JSON in prod).

  db/
    schema.ts         All database tables (the source of truth).
    schema.mirror.ts  GENERATED — the igdb_* canonical tables.
    client.ts         The Postgres connection pool + Drizzle client.
    migrate.ts        Applies SQL migrations (run on deploy).

  derive/             === Canonical + overrides -> the titles we serve ===
    fold.ts           Which title does a game belong to? (pure)
    typeset.ts        Smart punctuation for display text (pure)
    index.ts          deriveTitle(): one title row from a loaded subtree (pure)
    graph.ts          The parent graph in memory; membership for every game
    load.ts           Batch loading, so derive stays pure
    write.ts          Bulk upsert of titles / members / terms
    sweep.ts          Derive many titles at once (derive:all and the worker)
    one.ts            Derive a single title without loading the whole graph
    dirty.ts          Which titles a changed row affects
    worker.ts         Drains dirty_titles on LISTEN, with a poll as backstop

  search/
    normalize.ts      The one function both the search index and the user's
                      query go through. If they diverge, search breaks silently.

  mirror/             === The local IGDB mirror ===
    scheduler.ts      The nightly dump load.
    webhooks.ts       Registering with IGDB, and re-registering on boot.
    upsert.ts         One canonical row from JSON (webhooks + the fallback).
    endpoints.ts      What we mirror, and its types. Source of truth for the
                      generated schema, the staging DDL, and the drift guard.
    dumps.ts          The Data Partner dump API + the schema drift check.
    load.ts           Streams a dump into staging, diffs on checksum, applies
                      only what changed. Never hard-deletes.

  titles/
    read.ts           The whole API read path. Every route is one or two
                      indexed queries; nothing folds or computes at request
                      time. Maps rows to the response shape, so the storage
                      shape can change without touching the API contract.

  igdb/               === Live IGDB, now nearly idle ===
    token.ts          Fetches/caches/refreshes the Twitch (IGDB) access token.
    client.ts         The rate-limited request queue (the 4 req/s gate) + retries.

  routes/
    games.ts          GET /games/:id, /games/slug/:slug, /games/:id/members,
                      /games/search
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
> `deno task db:generate`, then run `deno task db:migrate` again. If you change
> `src/mirror/endpoints.ts`, run `deno task db:gen-mirror` first.

To stop the database: `docker compose down` (add `-v` to also wipe the data).

### Loading the IGDB mirror

```bash
deno task db:dumps                    # every endpoint, downloaded from IGDB
deno task db:dumps games covers       # just these
deno task db:dumps -- --local         # read the CSVs already in .dumps/
deno task db:dumps -- --force         # reload even if the dump is unchanged
```

A full build is ~1.2 GB and takes about half a minute. It is safe to re-run:
the loader diffs against IGDB's per-row `checksum`, so a run with no upstream
changes reports zero changes and touches nothing. An endpoint whose column
shape has drifted is skipped with an error rather than guessed at, and the
other nine still load.

`./.dumps/fetch.sh` downloads the raw CSVs for offline work. They are
gitignored (694 MB) and the presigned S3 URLs inside the saved metadata are
stripped, because those URLs are credentials for the whole file.

### Building the derived titles

```bash
deno task db:overrides                # load data/overrides/*.json
deno task derive:all                  # rebuild every title (~70s for 310k)
deno task derive:all -- --limit=200   # a slice, for iterating
deno task derive:all -- --fresh       # truncate the derived tables first
deno task derive:parity               # compare against the old cache
```

`derive:all` is safe to re-run: a title whose inputs have not changed is
skipped via `source_hash`, so a second pass over unchanged data writes nothing.
Editing anything in `data/overrides/` changes the overrides hash and so
re-derives everything — that is deliberate, and it takes about a minute.

Everything a human authors lives in `data/overrides/*.json`, never in the
database: platform and genre display names, manual fold corrections, and
per-title patches. Those files are the only place game data is hand-edited, so
every correction has a diff, an author and a reason.

The overrides version is a hash of the _parsed_ files, not their text, so
reindenting one or editing a `$comment` does not re-derive 309k titles. Changing
what they actually say does.

---

## Running (production)

```bash
deno task start               # run once (no watch)
```

The server listens on `PORT` (default 8000).

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

## The read path

Requests are served entirely from Postgres. There is exactly one code path left
that calls IGDB during a request: a game id we have never mirrored, which can
happen in the window between IGDB creating a game and our next dump. That path
fetches the single game, mirrors it, derives its title, and serves it.

`GET /games/:id` accepts **any** IGDB game id, including one that has since
folded into a parent — a DLC, a port, a Collector's Edition. It resolves through
`title_members` and returns the parent title with `resolvedFrom` set, so a saved
record never 404s because IGDB reorganised its catalogue.

Measured against the full 309k-title dataset: title reads are ~2 ms at p50,
searches ~10 ms.

## Endpoints

| Method | Path                    | Description                                            |
| ------ | ----------------------- | ------------------------------------------------------ |
| GET    | `/health`               | Liveness, plus mirror freshness and title count.       |
| GET    | `/games/:id`            | A title by any IGDB game id, folded children included. |
| GET    | `/games/slug/:slug`     | A title by slug.                                       |
| GET    | `/games/:id/members`    | Every IGDB id that resolves to this title.             |
| GET    | `/games/search?q=zelda` | Search, including folded DLC and alternative names.    |

Quick check:

```bash
curl localhost:8000/health
curl "localhost:8000/games/search?q=hollow%20knight"
```

---

## Staying fresh

Two mechanisms, and the second is what makes the first safe to rely on.

**Webhooks** give freshness in seconds. IGDB posts one changed entity; we mirror
it, work out which titles it affects, and wake the derive worker. Measured end
to end at about half a second.

**The nightly dump** is the reconciler. A missed delivery, a webhook IGDB
deactivated after five failures, an hour of downtime — all of it self-heals,
because the dump is the whole truth and the loader diffs against it. Freshness
degrades to 24 hours, never to silently wrong.

Both feed one queue (`dirty_titles`) drained by one worker. It listens for
`NOTIFY` so a webhook lands immediately, and polls every 60 seconds because a
title stuck dirty forever is a silent staleness bug.

`/health` reports all of it — last dump, pending titles, worker state, webhook
registration — because every failure here is invisible from the outside. If
`lastDumpAt` stops moving, freshness has stopped and nothing else will say so.

Webhooks are **off** unless `IGDB_WEBHOOKS_ENABLED=true`, and need `PUBLIC_URL`
and `IGDB_WEBHOOK_SECRET`. IGDB cannot deliver to localhost, and five failed
deliveries deactivate a webhook, so registering from a dev machine is worse than
not registering at all.

---

## How the data gets there (in plain terms)

Three layers, and data only ever flows one way. See
`docs/PLAN-igdb-mirror.md` for the full design.

1. **Canonical** (`igdb_*`) — a straight mirror of IGDB's daily dumps, never
   hand-edited. Rows are tombstoned, never deleted, because saved records point
   at their ids.
2. **Overrides** (`data/overrides/*.json`) — the only place a human writes game
   data. Platform and genre display names, fold corrections, per-title patches.
   In git, so every correction has a diff and a reason.
3. **Derived** (`titles`, `title_members`, `title_terms`) — the output of a
   pure function over the first two. This is what the API serves, and it can be
   thrown away and rebuilt in about a minute.

The interesting part is the fold. IGDB models a franchise as many separate game
records — the base game, its DLC, its ports, its Collector's Edition — and we
collapse all of that into one title. `title_members` records which ids fold
where, which is what lets a record saved against a DLC keep resolving after
IGDB reorganises around it.

`title_terms` is the search index: the title's own name, its alternative names,
and the names of everything folded into it. That is why searching "blood and
wine" finds The Witcher 3 rather than nothing.

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
  **multiple** instances you'd want a shared cache/lock (e.g. Redis). This
  matters much less than it used to — reads touch IGDB not at all.
- The database needs `pg_trgm` (migration `0005`) for search, and wants
  `pg_trgm.word_similarity_threshold = 0.6` (migration `0006`, which degrades
  to a `NOTICE` where the role cannot `ALTER DATABASE`).
- Plan for ~2.8 GB of Postgres: 1.2 GB canonical, 1.6 GB derived.

## Note on IGDB usage terms

IGDB is free for **non-commercial** use under the Twitch Developer Agreement.
A commercial product needs a partner agreement. We hold **Data Partner** access,
which is what unlocks the dumps and webhooks this service is built on; IGDB's
own FAQ prefers that partners store and serve the data themselves rather than
proxying live calls, which is exactly what we now do.
