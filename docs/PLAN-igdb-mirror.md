# Plan: IGDB local mirror, derived titles, and freshness pipeline

Status: **draft for review** (2026-09-02). Not yet started.

This document is the implementation plan for moving `respawn-social-api` from a
live read-through cache of the IGDB API to a locally-mirrored, derived dataset
fed by IGDB's partner data dumps and webhooks. It is written so that a
capable engineer (or coding agent) can implement it phase by phase without
needing the original design discussion.

Companion changes in the web app are in [§10](#10-web-app-changes-respawn-social-web).

---

## 1. Context

### What exists today

- `src/igdb/client.ts` — rate-limited (p-queue) request gate to IGDB.
- `src/igdb/data.ts` — read-through cache with stale-while-revalidate; every
  cold miss fetches from IGDB, resolves the root game, then folds related
  titles into it (`fold.ts`) using **3–4 further IGDB calls per game**.
- `src/igdb/fold.ts` — pure fold logic: ports merge platforms; dlcs/expansions
  contribute `expansions_normalized` + `extra_covers`; remasters contribute
  `editions` + `extra_covers`; version children contribute `editions`.
  Categories in `SEPARATE_CATEGORIES` get their own row; `NEVER_CATEGORIES`
  are never ingested.
- `src/db/schema.ts` — `games (id, slug, payload jsonb, checksum, fetched_at)`,
  `search_cache`, `oauth_token`.
- `src/routes/games.ts` — `GET /games/:id`, `GET /games/slug/:slug`,
  `GET /games/search?q=`. Search calls IGDB's `search` endpoint.
- `src/scripts/backfill-games.ts` — rewrites every mirrored row through the
  current fetch+fold pipeline when field lists or fold rules change.

### What changed

We now have IGDB **Data Partner** access, which unlocks:

- **Data dumps**: daily CSV export of every endpoint.
  - `GET /v4/dumps` → `[{ endpoint, file_name, updated_at }]`
  - `GET /v4/dumps/{endpoint}` → `{ s3_url, endpoint, file_name, size_bytes,
updated_at, schema_version, schema }` where `schema` is a map of column →
    type (`LONG`, `STRING`, `DOUBLE`, `TIMESTAMP`, `UUID`, `LONG[]`, …).
  - `s3_url` is a presigned URL valid for **5 minutes**.
  - Every row carries a `checksum` (UUID) that changes when the row changes.
  - `schema_version` changes when the column set changes.
- **Webhooks**: push notifications on create/update/delete.
  - Register with `POST /v4/{endpoint}/webhooks/`, body
    `application/x-www-form-urlencoded`: `url`, `secret`, `method`
    (`create` | `update` | `delete`). One registration per (endpoint, method).
  - Payload is a **single unexpanded entity** (relations as ids, same shape as a
    CSV row). `delete` sends only `{ "id": … }`.
  - Headers: `X-Secret`, `X-Endpoint`, `X-Operation`, `User-Agent:
IGDB-Webhook-Bot`. No static source IP; verify via secret + UA.
  - After **5 delivery failures** the webhook is set `active: false` and stops.
    Re-registering reactivates it. Re-register on service start.
  - `GET /v4/webhooks/` lists; `DELETE /v4/webhooks/{id}` removes.
- IGDB FAQ explicitly prefers that we store and serve the data ourselves.

Note: IGDB renamed `category` → `game_type` (same enum values). The dump
schema uses `game_type`.

---

## 2. Goals and non-goals

### Goals

1. **Zero IGDB calls on the read path.** Every `/games/*` request is served
   from Postgres.
2. **Canonical vs. augmented separation.** Raw IGDB data is never hand-edited.
   All augmentation (folding, renames, punctuation, colours) is either
   deterministic code or small, git-versioned override data. Everything
   augmented is reproducible from canonical + overrides.
3. **Freshness within minutes** via webhooks, **guaranteed within 24h** via the
   nightly dump (the dump is the reconciler; webhook misses self-heal).
4. **Stable identity for user records.** User PDS records are keyed by IGDB
   game id and must keep resolving correctly when IGDB folds, splits, or
   deletes games.
5. **Local search** that matches folded child names (DLC, expansion, edition,
   alternative names) and surfaces the parent title.

### Non-goals (for this plan)

- Local-first catalogue in the browser. See [§11](#11-local-first-notes) for
  what we do now and what we defer.
- Changing lexicons. `social.respawn.defs#gameRef` stays `{ igdbId, slug,
title }`.
- Multi-instance API deployment. Single Fly/Railway instance remains the
  assumption; the derive worker runs in-process.

---

## 3. Architecture

```
IGDB dumps (nightly CSV) ──┐
IGDB webhooks (intra-day) ─┴─▶ [1] CANONICAL  igdb_* tables      (never hand-edited)
                                          │
[2] OVERRIDES (git-versioned data files) ─┤
                                          ▼
                              derive(titleId) — pure, no network
                                          │
                                          ▼
                    [3] DERIVED  titles, title_members, title_terms,
                                 cover_colors                    (what the API serves)
```

**Layer 1 — canonical.** One table per dump endpoint we use, columns 1:1 with
the dump schema. Fed by dump loads and webhook upserts through the _same_
upsert function (payload shapes match).

**Layer 2 — overrides.** Hand-authored data in `data/overrides/*.json`,
loaded into tables on deploy (truncate + insert, idempotent). Small: aliases
for platform/genre display names, manual fold decisions, per-title patches.

**Layer 3 — derived.** Output of a pure function over layers 1 + 2. Fully
rebuildable. Contains everything the web app reads.

Flow is strictly one direction. Nothing writes upward.

---

## 4. Schema

Drizzle (`src/db/schema.ts`). Types below are illustrative SQL; use the
Drizzle equivalents. All timestamps `timestamptz`.

### 4.1 Canonical (`igdb_*`)

Start with these endpoints. Add more later as the front-end needs them.

| Table                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `igdb_games`              | The big one. Includes `game_type`, `parent_game`, `version_parent`, `version_title`, relation arrays (`dlcs`, `expansions`, `standalone_expansions`, `expanded_games`, `forks`, `ports`, `remakes`, `remasters`, `bundles`), `cover`, `platforms`, `genres`, `involved_companies`, `similar_games`, `websites`, `external_games`, `alternative_names`, `first_release_date`, `rating`, `total_rating_count`, `hypes`, `summary`, `storyline`, `slug`, `url`, `checksum`, `updated_at`. |
| `igdb_covers`             | `id, game, image_id, width, height, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `igdb_platforms`          | `id, name, abbreviation, slug, platform_family, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `igdb_genres`             | `id, name, slug, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `igdb_companies`          | `id, name, slug, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `igdb_involved_companies` | `id, game, company, developer, publisher, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `igdb_release_dates`      | `id, game, platform, date, region, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `igdb_websites`           | `id, game, url, type, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `igdb_external_games`     | `id, game, url, external_game_source, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `igdb_alternative_names`  | `id, game, name, comment, checksum`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Rules:

- Column names and types come from the dump `schema`. `LONG[]` → `bigint[]`.
  `TIMESTAMP` → `timestamptz`. `UUID` → `uuid`.
- Every canonical table gets two extra columns we own:
  `mirror_updated_at timestamptz not null default now()` and
  `deleted_at timestamptz null`. **Rows are never hard-deleted**; a webhook
  `delete` or absence from a dump sets `deleted_at`.
- `igdb_games` also gets `redirect_game_id bigint null` (see §7.3).
- Indexes: PK on `id`; `igdb_games(slug)`, `igdb_games(parent_game)`,
  `igdb_games(version_parent)`, GIN on each relation array we walk;
  `igdb_*(game)` on every child table.

Generate the Drizzle schema from the `schema` object returned by
`/dumps/{endpoint}` the first time; do not hand-type 100+ columns. A small
script `src/scripts/print-dump-schema.ts` that fetches and prints it is enough.

### 4.2 Overrides

Data files in `data/overrides/`, loaded by `src/scripts/load-overrides.ts`.

```sql
platform_aliases (platform_id bigint pk, display_name text, sort_order int)
genre_aliases    (genre_id    bigint pk, display_name text)
fold_overrides   (game_id     bigint pk,
                  action      text check (action in ('fold_into','keep_separate','hide')),
                  target_game_id bigint null,      -- required for fold_into
                  note        text)
title_patches    (game_id bigint pk, patch jsonb, note text)
-- patch keys allowed: display_name, summary, developers, publishers, first_release_date
overrides_meta   (id text pk default 'overrides', version text, loaded_at timestamptz)
```

`overrides_meta.version` is a content hash of the data files, computed by the
loader. Bumping it dirties every title (§6.4).

### 4.3 Derived

```sql
titles (
  id                     bigint pk,           -- root game id (== IGDB id of the root)
  slug                   text unique not null,
  name                   text not null,       -- raw IGDB
  display_name           text not null,       -- smart punctuation applied
  summary                text,
  summary_display        text,                -- smart punctuation applied
  game_type              int not null,
  first_release_date     timestamptz,
  release_year           int,
  cover_image_id         text,                -- from igdb_covers.image_id
  platforms              jsonb not null,      -- [{id, name, display_name, abbreviation, sort_order}]
  genres                 jsonb not null,      -- [{id, name, display_name}]
  developers             text[] not null,
  publishers             text[] not null,
  editions               text[] not null,     -- from remasters + version children (display form)
  expansions_normalized  text[] not null,     -- from dlcs/expansions (display form)
  extra_cover_image_ids  text[] not null,
  similar                jsonb not null,      -- [{id (resolved to title id), slug, display_name, cover_image_id}]
  websites               jsonb not null,
  external_games         jsonb not null,
  popularity             double precision not null default 0,  -- see §6.6
  status                 text not null check (status in ('live','deleted')),
  source_hash            text not null,       -- hash of member checksums + overrides version + DERIVE_VERSION
  derive_version         int not null,
  derived_at             timestamptz not null
)

title_members (
  game_id   bigint pk,                -- every game that resolves to this title, including the root
  title_id  bigint not null references titles(id),
  fold_type text not null             -- 'root' | 'port' | 'dlc' | 'expansion' | 'remaster' | 'version' | 'override'
)
-- index (title_id)

title_terms (
  title_id bigint not null references titles(id),
  term     text not null,             -- raw text
  term_norm text not null,            -- normalize() of term (§8.1)
  kind     text not null,             -- 'root_name' | 'alt_name' | 'member_name' | 'version_title' | 'edition'
  weight   char(1) not null,          -- 'A' | 'B' | 'C'
  primary key (title_id, term_norm, kind)
)
-- GIN trigram index on term_norm (pg_trgm)

cover_colors (
  image_id    text pk,
  dominant    text not null,          -- '#rrggbb'
  palette     jsonb,                  -- optional: [{hex, population}]
  computed_at timestamptz not null
)

dirty_titles (
  title_id   bigint pk,
  reason     text,
  queued_at  timestamptz not null default now()
)

igdb_events (
  id          bigserial pk,
  endpoint    text not null,
  op          text not null,          -- create|update|delete
  entity_id   bigint not null,
  checksum    uuid,
  received_at timestamptz not null default now(),
  unique (endpoint, entity_id, checksum, op)
)

dump_runs (
  endpoint        text pk,
  file_name       text,
  updated_at      bigint,             -- IGDB epoch seconds from /dumps
  schema_version  text,
  rows_loaded     int,
  rows_changed    int,
  rows_deleted    int,
  loaded_at       timestamptz
)
```

Drop `games`, `search_cache` once Phase 3 ships (§12). Keep `oauth_token`.

---

## 5. Data ingestion

### 5.1 Shared upsert

`src/mirror/upsert.ts`

```ts
upsertEntity(endpoint: Endpoint, row: Record<string, unknown>): Promise<{ changed: boolean }>
markDeleted(endpoint: Endpoint, id: number): Promise<void>
```

- `changed` is true when the row is new or its `checksum` differs from the
  stored one. Unchanged rows are a no-op (do not touch `mirror_updated_at`).
- Coerce types per the endpoint's column map (CSV gives strings; webhooks give
  JSON). One coercion table per endpoint, generated alongside the schema.
- `upsertEntity` clears `deleted_at` if the row reappears.

### 5.2 Nightly dump loader

`src/scripts/load-dumps.ts` — also exposed as a Deno task `db:dumps`. Runs
from an in-process cron (see §5.4) and can be run by hand.

Per endpoint, in order:

1. `GET /dumps`. If `updated_at` equals `dump_runs.updated_at`, skip.
2. `GET /dumps/{endpoint}`. If `schema_version` differs from `dump_runs.schema_version`
   **and** the column set differs from our table, **abort this endpoint, log
   at error level, and continue with the others.** Never guess a schema change.
3. Stream `s3_url` directly into `COPY igdb_{endpoint}_staging FROM STDIN
(FORMAT csv, HEADER true)`. The URL expires in 5 minutes; do not buffer to
   disk. `postgres` (the `postgres` npm package) supports `sql\`copy … from
   stdin\`.writable()`.
4. In one transaction:
   - `changed_ids` = ids in staging whose `checksum` differs from or is absent
     in live.
   - Upsert changed rows from staging into live.
   - `deleted_ids` = ids in live (with `deleted_at is null`) absent from
     staging → set `deleted_at = now()`.
   - Record counts in `dump_runs`.
5. Map `changed_ids ∪ deleted_ids` to titles (§6.5) and insert into
   `dirty_titles` with `reason = 'dump:{endpoint}'`.
6. Truncate staging.

Staging tables are `unlogged`, same columns as live, created by migration.

First-ever load: `title_members` is empty so step 5 finds nothing. The
initial derive is a full build (§6.7).

### 5.3 Webhooks

Route: `POST /webhooks/igdb` in `src/routes/webhooks.ts`.

```ts
// Verification — reject with 401 before reading the body.
const secret = c.req.header('X-Secret')
const ua = c.req.header('User-Agent')
if (secret !== config.IGDB_WEBHOOK_SECRET || ua !== 'IGDB-Webhook-Bot') return c.text('', 401)

const endpoint = c.req.header('X-Endpoint') // e.g. 'games'
const operation = c.req.header('X-Operation') // 'create' | 'update' | 'delete'
```

Handler:

1. Validate `endpoint` is one we mirror; else `204` (acknowledge, ignore).
2. `delete` → `markDeleted(endpoint, body.id)`.
   `create`/`update` → `upsertEntity(endpoint, body)`.
3. Insert into `igdb_events` (`on conflict do nothing`).
4. If changed, map to titles (§6.5) and insert into `dirty_titles` with
   `reason = 'webhook:{endpoint}:{op}'`.
5. `NOTIFY dirty_titles`.
6. Return `200` immediately. Never derive inline. Target < 50 ms.

Registration: `src/mirror/webhooks.ts` → `ensureWebhooks()` called on server
boot. For each `(endpoint, method)` in the mirrored set, `POST
/v4/{endpoint}/webhooks/` with `url = config.PUBLIC_URL + '/webhooks/igdb'`.
Treat `409` as already-registered. Then `GET /v4/webhooks/` and log any with
`active: false` at warn level (re-registration should have fixed them).

Env: `IGDB_WEBHOOK_SECRET` (random 32+ bytes), `PUBLIC_URL`, `IGDB_WEBHOOKS_ENABLED`
(default false in dev so local runs don't register a localhost URL).

### 5.4 Scheduling

In-process, single instance. `src/mirror/scheduler.ts`:

- Nightly dump load at a fixed UTC hour (env `DUMP_LOAD_HOUR`, default 06).
  Use `Deno.cron` if available on the platform, else a `setInterval` that
  checks the hour.
- Derive worker: `LISTEN dirty_titles` plus a 60 s poll as a safety net.

### 5.5 Fallback for unknown ids

Between a game being created on IGDB and our `create` webhook landing there
is a small window. `/games/:id` and `/games/slug/:slug` on a miss:

1. Look in `igdb_games` (including `deleted_at is not null`).
2. If absent, fetch **that single game** live via the existing rate-limited
   client, `upsertEntity`, mark dirty, derive synchronously, serve.
3. If IGDB returns nothing → `404`.

This is the only remaining live call on the read path. Keep `client.ts` and
`token.ts`; `IGDB_RATE_CAP` stays but is effectively idle.

---

## 6. Derive

`src/derive/` — pure modules plus one thin DB adapter.

### 6.1 Inputs

`loadSubtree(rootId)` returns, from canonical tables only, the root game and
every game reachable by walking (recursively) `ports`, `dlcs`, `expansions`,
`remasters`, and games whose `version_parent = root.id`, plus the referenced
covers, platforms, genres, companies, involved companies, alternative names,
websites, external games, and similar games (one level, ids only). A
recursive CTE over `igdb_games` is fine; a visited set breaks cycles exactly
as `fold.ts` does today.

### 6.2 Root resolution

Port `resolveRootGame` from `fold.ts`, local instead of network:

> **Corrected during Phase 2.** The order below is wrong in two places, both
> found by measuring the real catalogue. `version_parent` has to be tested
> BEFORE `game_type`, because IGDB files editions under both a type that would
> stop the climb and a type that would drop the game entirely:
>
> - 6,888 version children carry `game_type = 0` (main_game) while being plainly
>   editions — "Warhammer: Chaosbane - Slayer Edition", "Coridden: Deluxe
>   Edition". Testing the type first gives every one its own title row.
> - 923 more carry `game_type = 3` (bundle) — "Hollow Knight: Collector's
>   Edition". Testing NEVER_CATEGORIES first drops all 923 silently. The parity
>   check caught this one.
>
> `version_parent` is IGDB explicitly saying "this is a version of that", which
> is better evidence than the type. See `src/derive/fold.ts` for the shipped
> order. A version child that genuinely should not fold is what
> `fold_overrides.keep_separate` is for.

```
resolveRoot(gameId):
  if fold_overrides[gameId].action == 'fold_into' → resolveRoot(target_game_id)
  if fold_overrides[gameId].action == 'keep_separate' → gameId
  if fold_overrides[gameId].action == 'hide' → null
  if game_type ∈ NEVER_CATEGORIES → null            (bundle, mod, episode, season, pack, update)
  if game_type ∈ SEPARATE_CATEGORIES → gameId       (main, standalone expansion, remake, expanded game, fork)
  parent = version_parent ?? parent_game
  if parent is null or parent is deleted or cycle → gameId  (orphan child becomes its own title)
  → resolveRoot(parent)
```

### 6.3 Fold rules

Port `foldRelations` verbatim in behaviour:

| Relation walked                                                | Platforms | Name goes to                                                 | Cover goes to           | `fold_type` |
| -------------------------------------------------------------- | --------- | ------------------------------------------------------------ | ----------------------- | ----------- |
| `ports`                                                        | merge     | —                                                            | —                       | `port`      |
| `dlcs`                                                         | merge     | `expansions_normalized`                                      | `extra_cover_image_ids` | `dlc`       |
| `expansions`                                                   | merge     | `expansions_normalized`                                      | `extra_cover_image_ids` | `expansion` |
| `remasters`                                                    | merge     | `editions`                                                   | `extra_cover_image_ids` | `remaster`  |
| version children (`version_parent = root`)                     | —         | `editions` (uses `version_title`)                            | —                       | `version`   |
| `fold_overrides.fold_into` targets                             | merge     | `editions`                                                   | `extra_cover_image_ids` | `override`  |
| the root's own `parent_game`/`version_parent`, folded under it | merge     | subtitle (read-time, via `game_localizations`) + search term | `extra_cover_image_ids` | `original`  |

Children with `game_type ∈ NEVER_CATEGORIES` are skipped even when reachable.
Children with `deleted_at` set are skipped. Every folded child (including the
root itself with `fold_type = 'root'`) gets a row in `title_members`.

**Crowned ports.** IGDB files a localized release as a PORT of the game it
was adapted from — Super Mario Bros. 2 is a port of Yume Koujou: Doki-doki
Panic, Castlevania III of Akumajou Densetsu — so the climb above names every
such page after the obscure original. `deno task overrides:crown`
(`src/scripts/crown-ports.ts`) finds differently named ports whose popularity
(§6.6) is ≥20 and ≥3× their parent's, where the parent is itself a root, and
writes a `keep_separate` for the port plus a `fold_into` for the original into
`data/overrides/folds.json`, marked `generated: "crown"`. The original then
lands in `title_members` as `original`; `loadRelations` reads its
native-script name from `igdb_game_localizations` (ja-JP preferred) for the
page subtitle. Nineteen titles on the 2026-09 catalogue.

It is a generator, not a live rule, on purpose: rating counts drift, and a
root that flipped overnight would change a title's id under every user record
pointing at it. Frozen in git, the decision changes only when someone re-runs
the task and commits the diff. Hand-written overrides on either side of a
pair take precedence and remove the pair from consideration.

### 6.4 Smart punctuation

`src/derive/typeset.ts` — pure `typeset(text: string): string`. Applied to
`display_name`, `summary_display`, each `editions` and
`expansions_normalized` entry, and `similar[].display_name`. **Never applied
to `name`, `slug`, `title_terms.term`, or anything used for matching.**

Port the regexes from `~/Projects/rehype-typeset/plugin.js` (`replaceQuotes`,
`replacePunctuation`), dropping the HTML-entity lines. Required behaviour,
each a unit test in `typeset.test.ts`:

| Input                    | Output                 | Rule                                                                  |
| ------------------------ | ---------------------- | --------------------------------------------------------------------- |
| `Don't Starve`           | `Don’t Starve`         | apostrophe between letters → `’`                                      |
| `Assassin's Creed`       | `Assassin’s Creed`     | same                                                                  |
| `'90s Arcade Racer`      | `’90s Arcade Racer`    | leading `'` before digit is an elision → `’`, not `‘`                 |
| `Rock 'n' Roll Racing`   | `Rock ’n’ Roll Racing` | elision both sides → `’` both                                         |
| `"Quoted" Title`         | `“Quoted” Title`       | paired double quotes                                                  |
| `Half-Life`              | `Half-Life`            | hyphen between letters untouched                                      |
| `2019-2020`              | `2019–2020`            | digits both sides → en dash                                           |
| `Title - Subtitle`       | `Title – Subtitle`     | spaced hyphen → spaced en dash (house style; make it one constant)    |
| `Title -- Subtitle`      | `Title – Subtitle`     | double hyphen → en dash                                               |
| `Wait...`                | `Wait…`                | three dots → ellipsis                                                 |
| `Already ’ smart – here` | unchanged              | idempotent; running twice yields the same output                      |
| `Title  :  Sub`          | `Title: Sub`           | collapse whitespace, no space before colon, one after                 |
| `  Padded  `             | `Padded`               | trim                                                                  |
| `5'11"`                  | `5′11″`                | primes; low priority, keep if the ported regexes handle it, else skip |

Unmatched or ambiguous quotes are left as-is. If a title comes out wrong,
fix it with `title_patches.display_name`, not by adding a special case to the
code.

### 6.5 Dirty propagation

`affectedTitles(endpoint, ids[]) → titleId[]`:

- `games`: `title_members.title_id` for each id, **plus** the id itself if it
  has no member row yet (new game), **plus** for a changed game whose
  `parent_game`/`version_parent` changed, both the old and new root. Cheapest
  correct rule: include `title_members.title_id` for `id`, for its current
  `parent_game`, and for its current `version_parent`.
- `covers`, `involved_companies`, `release_dates`, `websites`,
  `external_games`, `alternative_names`: look up `game` on the changed row,
  then as above.
- `platforms`, `genres`, `companies`: potentially thousands of titles. Do not
  enumerate; instead bump a `reference_version` in `overrides_meta` (or a
  sibling row) so `source_hash` changes and the next full sweep recomputes.
  Trigger a background full sweep (§6.7) at low priority.

### 6.6 Popularity

`popularity = coalesce(total_rating_count,0) * 1.0 + coalesce(hypes,0) * 0.5`,
summed across the root and all members. Used only for search ranking. Tune
later.

### 6.7 Worker and full sweep

`src/derive/worker.ts`:

- Drain `dirty_titles` in batches of 50. For each title: compute
  `source_hash`; if it equals the stored one, delete from `dirty_titles` and
  skip. Else `deriveTitle`, write `titles` / `title_members` / `title_terms`
  in one transaction, delete from `dirty_titles`.
- When a game's root changes, the _old_ title may now have no members; if so
  delete that `titles` row (and its terms). `title_members` rows are
  rewritten wholesale per title on every derive.
- **Full sweep** (`deno task derive:all`): iterate every non-deleted
  `igdb_games` id whose `resolveRoot` returns itself, mark dirty, let the
  worker drain. Used for the initial build and after `DERIVE_VERSION` or
  overrides change. Expect it to take on the order of tens of minutes for the
  full catalogue; log progress every 1 000 titles.

`DERIVE_VERSION` is a constant in `src/derive/index.ts`. Bump it whenever
fold rules, typeset rules, or the `titles` shape change. It is part of
`source_hash`, so bumping it invalidates everything on the next sweep.

### 6.8 Cover colours

`src/derive/colors.ts`. Move the `sharp` dominant-colour extraction here from
the web app (`apps/web/src/lib/server/cover.ts`).

- Keyed by `cover_image_id`. Compute when `titles.cover_image_id` is new or
  changed (worker checks `cover_colors` after derive). Fetch
  `https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg`.
- Also serve lazily: `GET /covers/:imageId/colors` computes on miss.
- Store `dominant` as `#rrggbb`. Optional `palette` for later.

Deno + sharp: sharp ships prebuilt binaries and works under Deno 2 with
`nodeModulesDir: auto`; verify in the Dockerfile (`denoland/deno` image needs
`libvips` deps — sharp bundles them, but test the image build early).

---

## 7. Identity, resolution, and user records

User records in PDS repos (`social.respawn.game`, `social.respawn.backlog.item`,
`social.respawn.feed.log`) are keyed by IGDB game id and carry a denormalized
`gameRef { igdbId, slug, title }` plus, for game/backlog records, a cover blob.
They are **never bulk-rewritten**. The API resolves at read time.

### 7.1 Resolver

```ts
resolveTitle(igdbId): {
  titleId: number | null
  status: 'live' | 'folded' | 'deleted'
  via: 'root' | 'members' | 'redirect' | 'tombstone' | 'unknown'
}
```

Order:

1. `title_members` hit → `titleId`, status `live` if `fold_type = 'root'`, else `folded`, via `members`.
2. `igdb_games.redirect_game_id` set → recurse on the redirect, via `redirect`.
3. `igdb_games` row exists with `deleted_at` → `titleId = igdbId`, status `deleted`, via `tombstone`.
   The titles row for a deleted root is kept with `status = 'deleted'` so the
   page still renders from the last known data.
4. Nothing → `titleId = null`, via `unknown` (never mirrored; try §5.5 fallback).

Endpoint: `GET /games/resolve?ids=1,2,3` → `{ [id]: ResolveResult }`.
Batch, max 200 ids.

### 7.2 Folds and un-folds

- Game folded later: old id appears in `title_members` under the new root.
  Records at the old id resolve to the new title. Nothing else to do.
- Game un-folded (a child becomes `keep_separate` or its `game_type`
  changes): it gets its own `titles` row and `title_members` root entry.
  Records resolve straight.

### 7.3 Deletes

IGDB deletes are usually duplicate merges. The delete webhook carries only the
id, not the merge target. On `markDeleted('games', id)`:

1. Keep the row; set `deleted_at`.
2. Heuristic redirect: find a live game with the same `slug`, or the same
   normalized `name` and same `release_year`. If exactly one match, set
   `redirect_game_id`. Log at info level either way so it can be reviewed.
   If ambiguous, leave null; `fold_overrides` can set a manual `fold_into`
   later which the resolver honours through `title_members`.
3. Mark dirty. The derive keeps the `titles` row with `status = 'deleted'`.

Search excludes `status = 'deleted'`.

### 7.4 Duplicate records after a fold (web-app policy)

A user may hold a record at rkey `123` from before `123` folded into `456`,
then act on `456`. Policy, implemented in the web app (§10):

- **Read:** collect records, resolve each id, group by `titleId`, merge:
  `rating` and `played` from the most recently updated record; `liked` and
  `playing` OR-ed; `cover` from whichever record has one.
- **Write:** rkey is always the _current root id_. Before writing, if a record
  exists under any other member id of the same title, merge it into the root
  record and delete the old one. Same lazy-migrate pattern as
  `migrateLegacyBacklog`. One user, one action; no bulk job.
- **Logs:** history. Never moved or rewritten. Resolve at read to group under
  the title page; `listLogs` filters by the title's member ids, not a single
  raw id, so numbering doesn't split after a fold.
- **Backlog items:** same as game records.

### 7.5 AppView

HappyView indexes `social.respawn.backlog.item` by raw `igdbId`. Cross-user
queries after a fold need the member id set. Expose
`GET /games/:id/members` → `{ titleId, memberIds: number[] }` and have the
feed query accept the list. Out of scope for the first phases; note it in
`services/appview/README.md` when the endpoint exists.

---

## 8. Search

Drop the IGDB `search` endpoint and the `search_cache` table.

### 8.1 Normalization

`normalize(s)`: NFKD, strip combining marks, lowercase, fold `’`→`'` and
`‘`→`'`, fold `“”`→`"`, fold `–—`→`-`, collapse whitespace, trim. Applied to
`title_terms.term_norm` at derive time and to the user query at request time.
Same function, one module (`src/search/normalize.ts`).

### 8.2 Terms

Written by derive:

| kind            | source                                             | weight |
| --------------- | -------------------------------------------------- | ------ |
| `root_name`     | root `name`                                        | A      |
| `alt_name`      | `igdb_alternative_names.name` for root and members | B      |
| `member_name`   | `name` of every folded dlc/expansion/remaster/port | C      |
| `version_title` | `version_title` of version children                | C      |
| `edition`       | each `editions` entry (raw, pre-typeset)           | C      |

### 8.3 Query

`GET /games/search?q=` → `{ results: [{ title: TitleSummary, matched_term, kind }] }`

> **Corrected during Phase 2, against the real 309k-title index.** The query
> below (kept for the record) fails two of its own three tuning cases. Two
> reasons, both structural:
>
> 1. `similarity()` compares WHOLE strings, so a short query scores badly
>    against a long term. `similarity('blood and wine', 'the witcher 3: wild
hunt - blood and wine')` is 0.43, which loses to any random short title
>    containing "blood and". `word_similarity($q, term_norm)` scores 1.0 — it
>    asks how well the query matches some contiguous extent of the term, which
>    is exactly the question. But `word_similarity` alone then over-rewards long
>    junk titles that merely contain the query, so the shipped score blends
>    both.
> 2. Popularity as a tiebreaker (`order by score desc, popularity desc`) does
>    nothing, because scores rarely tie exactly. It has to be a term in the
>    score. Without it "botw" ranks "Botworld Odyssey" (popularity 1) above
>    Breath of the Wild (popularity 3,144).

Shipped query:

```sql
set pg_trgm.word_similarity_threshold = 0.6;

with hits as (
  select t.title_id, t.term, t.kind, t.weight,
         word_similarity($q, t.term_norm) as ws,
         similarity(t.term_norm, $q)      as sim,
         (t.term_norm like $q || '%')     as prefix
  from title_terms t
  where t.term_norm %> $q              -- pg_trgm word-similarity, GIN index
     or t.term_norm like $q || '%'
),
best as (
  select distinct on (title_id) title_id, term, kind,
         (case weight when 'A' then 1.0 when 'B' then 0.8 else 0.6 end)
         * (0.6 * ws + 0.4 * sim + (case when prefix then 0.25 else 0 end))
         as text_score
  from hits
  order by title_id, text_score desc
)
select b.*, ti.*
from best b join titles ti on ti.id = b.title_id
where ti.status = 'live'
order by b.text_score + 0.06 * ln(1 + ti.popularity) desc
limit 20;
```

The `ln(1 + popularity)` term is what stops a zero-popularity title with a
slightly better string match from burying the game the user meant; `0.06` is
worth about +0.5 for a top-tier title and +0 for an unknown one.

Verified top result on all eight tuning queries:

| Query             | Top result                              | Matched via   |
| ----------------- | --------------------------------------- | ------------- |
| `blood and wine`  | The Witcher 3: Wild Hunt                | `member_name` |
| `hearts of stone` | The Witcher 3: Wild Hunt                | `member_name` |
| `botw`            | The Legend of Zelda: Breath of the Wild | `alt_name`    |
| `zelda breath`    | The Legend of Zelda: Breath of the Wild | `root_name`   |
| `half life`       | Half-Life                               | `root_name`   |
| `witcher 3`       | The Witcher 3: Wild Hunt                | `alt_name`    |
| `mario kart`      | Mario Kart 8                            | `root_name`   |
| `elden`           | Elden Ring                              | `root_name`   |

The first two are the case the whole `title_terms` design exists for: a query
that matches a folded DLC surfaces the parent title, not a dead end.

<details><summary>Original query, which does not rank correctly</summary>

```sql
with hits as (
  select t.title_id, t.term, t.kind, t.weight,
         similarity(t.term_norm, $q) as sim,
         (t.term_norm like $q || '%') as prefix
  from title_terms t
  where t.term_norm % $q            -- pg_trgm, GIN index
     or t.term_norm like $q || '%'
),
best as (
  select distinct on (title_id) title_id, term, kind,
         (case weight when 'A' then 1.0 when 'B' then 0.8 else 0.6 end)
         * (sim + (case when prefix then 0.3 else 0 end)) as score
  from hits
  order by title_id, score desc
)
select b.*, ti.*
from best b join titles ti on ti.id = b.title_id
where ti.status = 'live'
order by b.score desc, ti.popularity desc
limit 20;
```

</details>

---

## 9. API contract

Routes under `src/routes/`. Existing paths keep working; response shape
changes from raw IGDB payload to a `Title` object. Version the shape with a
`v` field so the web app can assert on it.

| Method | Path                      | Response                                                                                                                            |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/games/:id`              | `{ title }` — resolves child ids to the root; `303`-style: returns the root title with `resolved_from: id` when `id` isn't the root |
| GET    | `/games/slug/:slug`       | `{ title }`                                                                                                                         |
| GET    | `/games/search?q=`        | `{ results: [{ title: TitleSummary, matched_term, kind }] }`                                                                        |
| GET    | `/games/resolve?ids=`     | `{ [id]: ResolveResult }`                                                                                                           |
| GET    | `/games/:id/members`      | `{ titleId, memberIds }`                                                                                                            |
| GET    | `/covers/:imageId/colors` | `{ dominant, palette? }`                                                                                                            |
| POST   | `/webhooks/igdb`          | `200` / `401`                                                                                                                       |
| GET    | `/health`                 | add `mirror: { lastDumpAt, dirtyCount, webhooksActive }`                                                                            |

`Title` = the `titles` row with `cover_url` derived from `cover_image_id`
(`t_cover_big`), plus `members: number[]`. `TitleSummary` = `id, slug,
display_name, cover_image_id, release_year, platforms[].display_name`.

Cache headers: `Cache-Control: public, max-age=300, stale-while-revalidate=86400`
and `ETag` = `source_hash` on title responses.

---

## 10. Web app changes (`respawn-social-web`)

Do these after Phase 3 (§12) ships in the API.

1. `apps/web/src/lib/types/game.ts` — replace `Game` with `Title` /
   `TitleSummary` matching §9. Remove `[key: string]: unknown`.
2. `apps/web/src/lib/server/backend.ts` — add `resolveGames(ids)`,
   `getMembers(id)`, `getCoverColors(imageId)`.
3. `apps/web/src/routes/game/[slug]/+page.server.ts` — delete the ad-hoc
   `developer`/`publisher`/`releaseYear`/`similar_games` shaping; the title
   already has it. Use `display_name` everywhere a name is rendered; write
   `display_name` into `gameRef.title` on new records.
4. `apps/web/src/lib/server/cover.ts` — `buildCover` fetches `dominant` from
   the API instead of running `sharp`. Keep uploading the blob to the PDS.
   Drop the `sharp` dependency from `apps/web` once nothing else uses it.
5. Implement §7.4: a `resolveAndMerge(records)` helper in
   `apps/web/src/lib/atproto/`, used by profile/backlog/games pages; and the
   write-side migrate in the game record and backlog actions.
6. `listLogs` filtering by member ids (§7.4).
7. Search page: show `matched_term` under the title when `kind !== 'root_name'`
   ("includes Blood and Wine").

---

## 11. Local-first notes

Deferred. Decisions already made:

- **User data** (records) is where local-first pays. PDS is the source of
  truth; a client cache + optimistic UI + sync is a separate plan. The
  denormalized `gameRef` is the safety net that keeps records renderable
  without the catalogue and must stay.
- **Catalogue** in the browser is not feasible as a full copy. What we do
  now, cheaply:
  - Title responses carry `ETag` + long `stale-while-revalidate` so the browser
    HTTP cache is a local store.
  - Later: IndexedDB cache of touched/recently-viewed titles keyed by
    `id + derived_at`. Search stays server-side.
- A "lite shard" (id, slug, display_name, year, cover id, platform ids) now
  has real numbers behind it: **316,372 titles**. At roughly 80 bytes per
  title that is ~25 MB raw and plausibly 8–10 MB gzipped. Too big to ship on
  first load, but genuinely viable as an **opt-in PWA download** with local
  search — better than the "infeasible" assumption this plan started from.
  Measure the real gzipped size at the end of Phase 2 before committing.

---

## 12. Phases and acceptance criteria

Each phase is independently mergeable. Do not start a phase until the
previous one's criteria pass.

### Phase 0 — spike ✅ done 2026-09-02

- Partner dump access confirmed working against the live credentials in `.env`.
- All ten endpoints downloaded to `.dumps/` (gitignored) by `./.dumps/fetch.sh`,
  which re-fetches each presigned URL immediately before its download and
  strips the URL from the saved metadata afterwards.
- Sizes, row counts, `game_type` distribution and CSV format recorded in §13.
- Open questions 1 and 6 resolved.

### Phase 1 — canonical mirror + dump loader ✅ done 2026-09-03

All acceptance criteria met:

- Migrations `0002` (ten `igdb_*` tables + `dump_runs`) and `0003` (GIN indexes
  on the fold relation arrays, for reverse "which root lists this id?" lookups).
- `deno task db:dumps` loads every endpoint end to end, from IGDB or from
  local files (`--local[=dir]`, for iterating without a 694 MB download).
- Second run with no upstream changes reports `rows_changed = 0` for all ten
  endpoints — 3.5 M rows verified in 11.9 s.
- Schema drift aborts that endpoint only, error-logs the specific column, and
  leaves both the table and its `dump_runs` row untouched. Verified with a
  doctored `schema` object.
- Tests in `src/mirror/dumps.test.ts` (header parsing, drift detection) and
  `src/mirror/copy.test.ts` (what `COPY` actually does with IGDB's CSV).

Deviations from the plan above, all deliberate:

1. **Staging tables are created per run from the CSV's own header**, not by
   migration. `COPY` matches fields to columns _positionally_ — the header is
   skipped, not read — so a staging table in the wrong order loads the wrong
   data into the wrong columns, silently. Building staging from the header
   (mirrored columns get their real type; everything else is `text`) removes
   that assumption entirely and lets IGDB add columns upstream for free. The
   loader reads the header with a 64 KB `Range` request before downloading.
2. **There is no JS coercion layer on the dump path.** IGDB writes Postgres
   array literals, `t`/`f` booleans and formatted timestamps, so `COPY` parses
   all of it natively. §5.1's `upsertEntity` is still needed for webhooks
   (which deliver JSON) and moves to Phase 4.
3. **`src/mirror/endpoints.ts` is the single source of truth** for what we
   mirror. `src/db/schema.mirror.ts` is generated from it by
   `deno task db:gen-mirror` (and committed) — ~130 columns is too many to
   hand-type. The same file drives the staging DDL, the `COPY` column list and
   the drift guard.
4. `GET /v4/dumps` is called once per run so an unchanged endpoint costs one
   listing entry rather than a detail call and a download.

**Gotcha for Phase 2:** postgres.js returns `int8` as a **string**, including
array elements — `id` comes back as `'1942'` and `platforms` as
`['6','14','130']`. Drizzle's `bigint({ mode: 'number' })` converts, hand-written
SQL does not. This already caused one bug here (the "dump unchanged" check
compared `'1788328800' === 1788328800` and so never fired). Pinned in
`copy.test.ts`.

### Phase 2 — derive ✅ done 2026-09-03

All acceptance criteria met:

- `resolveRoot`, `foldTypeOf`, `contributionOf`, `typeset`, `normalize` and
  `deriveTitle` are pure and unit-tested — 63 tests, no DB.
- `deno task derive:all` builds the full catalogue: **309,568 titles from
  374,343 games in 67 s**, 28,342 games ignored. A re-run with nothing changed
  writes zero rows in 12.9 s, because `source_hash` matches.
- `deno task db:overrides` loads `data/overrides/*.json` and writes a content
  hash; changing one file re-derived all 309,568 titles, which is the intended
  blast radius.
- **Parity check** `deno task derive:parity` against the 560 rows of the old
  cache: every class of difference is accounted for (below).
- All 14 typeset cases in §6.4 pass, plus idempotency.
- Search verified against the real index; §8.3 rewritten as a result.

**Parity results** — 558 compared, 2 unresolvable (both deleted from IGDB
entirely), 0 regressions:

| Class                   | Count | Explanation                                                                                    |
| ----------------------- | ----: | ---------------------------------------------------------------------------------------------- |
| extra covers differ     |    65 | Gains. Version children now contribute their cover art.                                        |
| editions differ         |    44 | 39 are typeset only (`Collector's` → `Collector’s`); 5 are gains from bundle version children. |
| expansions differ       |    22 | 21 typeset only; 1 correctly reclassified as an edition.                                       |
| platforms / genres      |    10 | The old cache is stale — rows written weeks ago.                                               |
| developers / publishers |     7 | Same.                                                                                          |

The single reclassification is worth reading, because it shows the fold working
as intended: game 396407 carries **both** `parent_game` and `version_parent`
pointing at Tactical Breach Wizards. The old pipeline found it in `dlcs` and
listed the full string "Tactical Breach Wizards: Special Edition" under
expansions; the new one sees `version_parent` and lists "Special Edition" under
editions, which is what a reader wants.

**Deviations from the plan above, all deliberate:**

1. **Membership follows parent pointers, not relation arrays** (§6.1/§6.3).
   Walking down `parent_game`/`version_parent` — rather than the nine relation
   arrays — is the same set in practice and is self-consistent with
   `resolveRoot` by construction, which is what guarantees the
   `title_members.game_id` primary key holds. Measured before committing to it:
   of 28,900 relation-array edges, exactly **2** disagree with the child's
   parent pointer, 2 more point at games we do not mirror, and 1 foldable child
   is an orphan. All 28,898 parented children are listed by their parent. It
   also reads off an indexed column instead of nine GIN lookups.
2. **`fold_type` comes from the member's own `game_type`**, not from which
   array listed it — same reasoning.
3. **The whole parent graph is loaded into memory** for a sweep (374k rows,
   ~60 MB) and every root resolved in one pass. A recursive CTE per title would
   be ~309k round trips; this is 200 ms.
4. **Version children contribute their cover art** to `extra_cover_image_ids`.
   The old pipeline did not. A Collector's Edition has real alternate box art.

**Still open from this phase:** `title_patches` and `fold_overrides` are wired
end to end but empty — the mechanism is tested, no real corrections are needed
yet. `data/overrides/platforms.json` and `genres.json` carry a starting set of
38 platform and 8 genre display names, which are an editorial call to revise.

### Phase 3 — serve from derived ✅ done 2026-09-03

- Routes per §9, served entirely from Postgres. `/games/:id` on a folded
  child's id returns the root title with `resolvedFrom` set — verified with
  116151 ("Hollow Knight: Collector's Edition") → 14593 (Hollow Knight).
- Unknown-id fallback (§5.5) verified end to end by deleting a game from the
  mirror and requesting it: live IGDB fetch → `upsertEntity` → `deriveOne` →
  served, with the right release date. It is the only path that calls
  `igdbRequest` during a request.
- `search` runs on `title_terms` with the §8.3 ranking. All eight tuning
  queries return the expected top result.
- `games` and `search_cache` dropped (migration 0007). `backfill-games.ts`,
  `parity.ts`, `igdb/data.ts`, `igdb/fold.ts` and `lib/single-flight.ts`
  deleted — the entire read-through cache is gone. `igdb/client.ts` and
  `token.ts` remain for the fallback and the dump loader.
- Web app updated per §10 items 1, 2, 3 and 7.

**Measured on the full 309,568-title dataset:**

| Operation              | p50     | p95     |
| ---------------------- | ------- | ------- |
| `GET /games/:id`       | 2.0 ms  | 3.9 ms  |
| `GET /games/search?q=` | 10.5 ms | 20.4 ms |

A title response is ~7.4 KB.

**§10 item 4 is deferred to Phase 6, deliberately.** It moves cover-colour
extraction out of the web app and into `GET /covers/:imageId/colors`, and that
endpoint is Phase 6 work. Nothing in Phase 3 can land it, so `sharp` stays in
`apps/web` for now.

**Deviations and finds:**

1. **`similar` needs quoting in SQL.** `SIMILAR` is a reserved keyword
   (`SIMILAR TO`), so `select ..., similar, ...` is a syntax error rather than
   a column reference. Only the derived layer hit this, because it is the only
   place we select that column by name.
2. **Timestamps were parsed as local time.** `new Date("2015-05-19 00:00:00")`
   resolves a bare datetime against the LOCAL zone, so on a UTC-6 machine every
   date landed six hours late — and dev and prod would have disagreed. Fixed in
   `coerce`, and pinned for the SQL path too: `TimeZone: 'UTC'` is now a startup
   parameter on the connection, because Postgres resolves a bare timestamp
   against the _session's_ zone and a per-statement `set time zone` is
   unreliable against a pool.
3. **postgres.js cannot serialize a `Date` through its dynamic-object insert**
   (`ERR_INVALID_ARG_TYPE`), nor accept a nested `sql.unsafe()` as a value.
   `coerce` returns ISO strings and the upsert uses `sql(obj, ...keys)` in both
   INSERT and SET position.
4. **`deriveOne` walks a subtree instead of the whole graph.** `derive:all`
   loads all 374k games to resolve roots in one pass, which no request can
   afford. `src/derive/one.ts` walks the seed's ancestors, then the root's
   descendants — a handful of small indexed queries. Phase 4's worker will use
   the same function.
5. **`igdbUrl` is derived, not stored.** The page needs a link to IGDB and
   `titles` has no `url` column; it is built from the slug in the response
   mapper.
6. The response uses **camelCase** throughout, not the snake_case of §9's
   sketch, matching the web app's existing conventions.

### Phase 4 — freshness ✅ done 2026-09-04 (built and verified locally)

- `POST /webhooks/igdb` with secret + user-agent verification. 12 tests cover
  every rejection and every operation.
- `ensureWebhooks()` on boot; `/health` reports the worker, the scheduler and
  the webhook registration together.
- Derive worker drains `dirty_titles` on `LISTEN`, with a 60 s poll as a safety
  net. **A manual canonical `UPDATE` plus a dirty insert was visible on
  `/games/:id` in 0.04 s.** A webhook end to end — receive, mirror, queue,
  derive, serve — took ~0.5 s, including one arriving on a child endpoint
  (`covers`) and propagating to its parent title.
- Nightly dump scheduled (off by default; `DUMP_SCHEDULE_ENABLED`). A load with
  changes queues only the affected titles: a `games` reload that found 1 changed
  row queued exactly 1 title.

**Nothing is registered with IGDB.** `IGDB_WEBHOOKS_ENABLED` defaults to false
and stays false until there is a public URL — IGDB cannot deliver to localhost,
and five failed deliveries deactivate a webhook. The route was exercised
locally with a dev secret.

**Deviations and finds:**

1. **The worker picks its strategy by backlog size.** `deriveOne` per title
   walks just that subtree; a `sweep` loads the whole 374k-game parent graph
   once and resolves every root in a pass. Under 500 pending titles the first is
   cheaper; over it the second is, by a wide margin — running `deriveOne` 46,000
   times after a nightly dump would take hours. Both paths now share
   `src/derive/sweep.ts` with `derive:all`.
2. **Dirty propagation is entirely set-based.** §6.5 describes it per-id, which
   would be 46k round trips a night. `markDirtyForEndpoint` maps changed ids to
   titles in one statement, driven off a table the loader fills rather than ids
   shipped through the client.
3. **`platforms`/`genres` mark every title dirty** rather than §6.5's
   `reference_version` scheme. 220 and 23 rows that change maybe twice a year,
   against a sweep that takes a minute — the bookkeeping cost more than the
   work it avoided. `companies` joins through `involved_companies` and stays
   precise.
4. **The dump loader NOTIFYs.** `deno task db:dumps` run by hand queues work for
   a server running in a different process, which would otherwise sit until the
   60 s poll.
5. **The first dump load skips queueing entirely.** With `titles` empty every
   changed game looks like a new title, so the first load would queue all 374k.
   The initial build is `derive:all`, which needs no queue.
6. **Reasons are inlined into SQL, and validated first.** These statements build
   their FROM clause from a table name so they use `unsafe`, whose bound
   parameters postgres.js types as `never` for an untyped client. The one
   dynamic value is inlined behind a character-set check, with a test that a
   reason carrying SQL is refused.

**Note for whoever writes tests next:** anything that writes canonical rows
races a derive worker running against the same database, which will happily
build a title from your fixture. Test cleanup has to remove `titles` and
`title_terms` too, not just the canonical side.

### Phase 5 — identity ✅ done 2026-09-04

- `resolveTitles` (batched), `GET /games/resolve?ids=`, `/games/:id/members`.
- Delete handling: heuristic redirect plus a tombstone `titles` row that keeps
  serving. Verified with a synthetic duplicate merge — an accented-name twin
  deleted, redirected to its survivor, and a record at the dead id landing on
  the survivor's page.
- Web app §10 items 5–6: `title-identity.ts` (resolve, group, merge,
  consolidate-on-write) and `listLogs` filtering by every member id.

**Three corrections to this section, all found by testing rather than reading:**

1. **§7.1's resolution order is wrong.** It says members, then redirect. But a
   deleted game keeps its `title_members` rows, so membership always wins and
   the redirect branch is unreachable — for precisely the case redirects exist
   to handle. The shipped order resolves membership first, and then yields to a
   redirect when the title it found is `status = 'deleted'`. A live title always
   wins; a tombstone gives way to a known replacement.
2. **The §7.3 name match cannot use a SQL prefix filter.** The difference it
   has to see through is the one a `lower(left(name, n))` comparison is blind
   to: "Tést Merge Game" and "Test Merge Game" normalize to the same string and
   share no lowercase prefix. Postgres has no NFKD without an extension, so the
   match goes through `title_terms.term_norm`, which derive already populated
   with the same `normalize()` search uses. One definition, one index
   (migration `0010`).
3. **The year rule is stricter than the plan implies.** If the deleted game has
   a release year, the survivor must have the _same_ one, including having one
   at all. A candidate with no date is not evidence of a match. A tombstone is
   recoverable; a wrong redirect silently reattaches someone's rating to a
   different game and nothing in the UI would reveal it.

**Also fixed here:**

- **`titles.slug` was unique across tombstones**, which would have broken the
  first real delete: IGDB hands a deleted duplicate's slug to its survivor, and
  deriving the survivor would have hit the unique index. Now partial on
  `status = 'live'` (migration `0009`), and `/games/slug/:slug` prefers the live
  title.
- **`/games/:id` and `/games/resolve` disagreed.** The first read
  `title_members` directly and served the tombstone; the second followed the
  redirect. Both now go through the resolver.
- **Open question 4 resolved** (see §14): `similar` already dropped entries
  resolving back to the same title; it now also excludes deleted ones.

**Deliberately not done:** §7.5 (the AppView member-id query) — the endpoint it
needs exists now, but the change belongs in `services/appview`, not here.

### Phase 6 — cover colours ✅ done 2026-09-04

- `cover_colors` populated by `deno task colors:backfill`, plus lazy compute on
  `GET /covers/:imageId/colors`. `/health` reports how many are still pending.
- Web `buildCover` reads the colour from the API; **`sharp` removed from
  `apps/web`** entirely.
- `sharp` under Deno 2 works, and works in the Docker image on both
  `linux/arm64` and `linux/amd64` — the plan's open worry, now closed. See
  §13.4.

**Measured:** ~35 covers/sec at concurrency 6. 267,041 distinct covers across
309,568 live titles, so a full backfill is roughly two hours. It is deliberately
a separate opt-in command, not something a derive run triggers.

**Deviations from §6.8:**

1. **No worker hook.** §6.8 has the derive worker check `cover_colors` after
   each derive, which would make a full sweep attempt 267k image fetches inline.
   Instead the pending set is a QUERY — live titles left-joined to
   `cover_colors` — drained by an opt-in command and topped up lazily by the
   endpoint. Nothing to keep in sync, nothing lost if a run dies halfway, and a
   cover that arrives after the last backfill still answers on first request.
2. **The palette is real.** §6.8 has it as an optional extra; the first
   implementation resized to 3x3 and counted pixels, which gave nine "colours"
   each with population 1 — technically a palette, useless as one. It now
   downsamples to 8x8 and buckets near-identical pixels so populations mean
   something.
3. **Colour lookup is best-effort on the write path.** A cover with no colour
   still uploads. Failing a user's action because a tint is unavailable is the
   wrong trade.

**Worth knowing:** `dominant` comes from `sharp`'s histogram and skews light —
The Witcher 3's cover gives `#e8f8f8`, nearly white, while the palette's top
swatch is `#615e5f`. That is unchanged from what the web app computed before, so
nothing regressed, but the palette is probably the better tint source. See open
question 17.

---

## 13. Numbers

Measured 2026-09-02 from the dump dated `1788328800`. Files are in
`.dumps/` (gitignored); re-fetch with `./.dumps/fetch.sh`.

| Endpoint           |    Rows | CSV size | schema_version | Cols |
| ------------------ | ------: | -------- | -------------- | ---- |
| games              | 374,217 | 292.4 MB | 1739944800     | 60   |
| covers             | 336,018 | 41.5 MB  | 1784008800     | 11   |
| platforms          |     220 | 0.04 MB  | 1739944800     | 17   |
| genres             |      23 | 0.003 MB | 1700060400     | 7    |
| companies          |  72,660 | 19.2 MB  | 1771308000     | 27   |
| involved_companies | 284,561 | 28.1 MB  | 1700060400     | 10   |
| release_dates      | 582,873 | 78.2 MB  | 1753250400     | 16   |
| websites           | 967,493 | 96.6 MB  | 1739944800     | 7    |
| external_games     | 679,212 | 119.0 MB | 1739944800     | 15   |
| alternative_names  | 213,347 | 18.6 MB  | 1700060400     | 5    |

Total ≈ 694 MB of CSV. Titles after Phase 2: **309,568** (predicted 316,372 as
an upper bound, see below — the 6,804 difference is version children that fold
instead). `derive:all` wall time: **67 s**.

### 13.4 Phase 6, measured 2026-09-04

|                                 |                                       |
| ------------------------------- | ------------------------------------- |
| Distinct covers on live titles  | 267,441                               |
| Extraction rate (concurrency 6) | ~35/sec                               |
| Full backfill, estimated        | ~2 hours                              |
| `cover_colors` row              | image id, `#rrggbb`, 3-swatch palette |

`sharp` runs under Deno 2 with `nodeModulesDir: auto`, and its native install
script needs approving once (`deno approve-scripts sharp`). The tasks that touch
it need `--allow-ffi`, which is now on `dev`, `start`, `test` and
`colors:backfill`.

It also works in the `denoland/deno` image, verified on `linux/arm64` and
`linux/amd64`: `deno install` runs sharp's install script inside the container
(the build log shows `Initialize sharp@0.34.4`), the approval recorded in
`deno.lock` carries over, and decoding a real cover in the image returns exactly
the host's answer. npm's optional dependencies pull the right prebuilt binary
per platform, so the Dockerfile needs no apt packages and no changes.

### 13.3 Phase 2, measured 2026-09-03

| Table           |    Rows | Total   | Heap    | Indexes + TOAST |
| --------------- | ------: | ------- | ------- | --------------- |
| `titles`        | 309,568 | 1320 MB | 1013 MB | 307 MB          |
| `title_terms`   | 541,749 | 211 MB  | 64 MB   | 148 MB          |
| `title_members` | 346,001 | 50 MB   | 22 MB   | 28 MB           |

Database total 2,767 MB, of which 1,175 MB is the canonical mirror.

**`titles` is bigger than it needs to be, and the cause is jsonb key repetition.**
The denormalized columns account for most of it — `similar` 167 MB, `summary`

- `summary_display` 139 MB, `external_games` 64 MB, `websites` 58 MB,
  `platforms` 43 MB, `genres` 33 MB — but those column sizes sum to ~500 MB
  against a 1013 MB heap, and the gap is jsonb storing the key names
  (`displayName`, `abbreviation`, `sortOrder`, …) once per array element per row.
  Three ways to spend less, in order of how much they buy:

* Store `platforms`/`genres` as plain `bigint[]` of ids and join the 220-row
  and 23-row lookups at read time. They are tiny, cached, and change ~never.
  Saves ~76 MB of column data and considerably more heap.
* Drop `summary_display` and typeset on read. It is a pure function of
  `summary`, and 139 MB is a lot to pay to avoid calling it.
* Keep `similar` as ids and resolve on read; 167 MB for a "you might also like"
  strip is the worst ratio in the table.

**Measured in Phase 3, and the answer is that the denormalization buys
nothing.** `GET /games/:id` is 2.0 ms at p50 against the full dataset — a
primary-key lookup plus one indexed member query. There is no latency budget
being protected here, so the ~370 MB is available whenever it is worth an
afternoon. `src/titles/read.ts` maps rows to the response shape explicitly, so
this is a change to that one file and not to the API contract.

Note also that this does NOT change the local-first estimate in §11, which was
always about a lite shard of id/slug/name/year/cover, not these rows.

### 13.0 Phase 1, measured 2026-09-03

694 MB of CSV becomes **1,175 MB** of `igdb_*` tables and indexes (1,186 MB
database). Loader wall times, on a local Docker Postgres 17:

| Run                                                         | Wall time |
| ----------------------------------------------------------- | --------- |
| Full build, all ten endpoints from `.dumps/`                | 25.5 s    |
| Re-run, nothing changed (3.5 M rows diffed)                 | 11.9 s    |
| Nightly run against IGDB, incl. the 292 MB `games` download | 33.8 s    |

The 5-minute presigned URL is not a constraint at this scale: `games` streams
and merges in 14.4 s.

**One day of IGDB churn**, from the 2026-09-02 dump to the 2026-09-03 one:

| Endpoint           | Changed | Deleted |
| ------------------ | ------: | ------: |
| games              |  46,748 |       0 |
| covers             |   8,270 |      22 |
| external_games     |     866 |       0 |
| release_dates      |     450 |     249 |
| websites           |     344 |      18 |
| involved_companies |     308 |      71 |
| alternative_names  |     257 |   1,871 |
| companies          |      99 |       0 |

**46,748 changed games is 12.5% of the catalogue in a single day** — far more
than the plausible number of real edits, so IGDB is bumping `checksum` on rows
whose content we care about did not change. That matters for §6: if every
changed game marks a title dirty, the derive worker re-derives ~46k titles a
night for almost no benefit. Two mitigations, both cheap:

- `source_hash` already guards the write — the worker hashes member checksums
  and skips when it matches. But it still pays for `loadSubtree` on 46k titles.
- Better: narrow the dirty trigger to the columns derive actually reads (name,
  slug, summary, game_type, parent/version, the relation arrays, cover,
  platforms, genres, companies, dates) instead of `checksum` alone. Measure the
  real figure in Phase 2 before optimising.

Nothing was tombstoned on `igdb_games`, so `deleted_at` and the §7.3 redirect
heuristic are still untested against a real IGDB delete.

### 13.1 `game_type` distribution (all 374,217 games)

| `game_type` | Name                 |   Count | Fate under §6.2/§6.3            |
| ----------: | -------------------- | ------: | ------------------------------- |
|           0 | main_game            | 312,120 | own title                       |
|           4 | standalone_expansion |     504 | own title                       |
|           8 | remake               |   1,472 | own title                       |
|          10 | expanded_game        |   2,141 | own title                       |
|          12 | fork                 |     135 | own title                       |
|           1 | dlc                  |  17,615 | folds → `expansions_normalized` |
|           2 | expansion            |   1,733 | folds → `expansions_normalized` |
|           9 | remaster             |   1,380 | folds → `editions`              |
|          11 | port                 |   8,215 | folds → platforms only          |
|           3 | bundle               |   7,133 | never ingested                  |
|           5 | mod                  |   9,778 | never ingested                  |
|           6 | episode              |     960 | never ingested                  |
|           7 | season               |     864 | never ingested                  |
|          13 | pack                 |   8,952 | never ingested                  |
|          14 | update               |   1,215 | never ingested                  |

Own title: **316,372**. Folds into a parent: **28,943**. Never ingested:
**28,902**. Sums to 374,217 exactly, so the categories are exhaustive and
every game has a `game_type` (none empty).

Use 316,372 as the expected `titles` row count in the Phase 2 acceptance
check; a large deviation means `resolveRoot` is wrong. It is an upper bound —
a few of those will fold via `version_parent` instead.

Also measured: `parent_game` set on **54,962** rows, `version_parent` on
**8,006**, and **zero duplicate slugs** across all 374,217 games. Slug
uniqueness is what makes the §7.3 delete-redirect heuristic viable, and means
`titles.slug` can keep its unique constraint.

### 13.2 Confirmed CSV format (resolves §14 Q1 and Q6)

Verified by inspecting `games.csv` directly.

- **Arrays (`LONG[]`, `INTEGER[]`) are Postgres array literals**: `{6,14,130}`.
  They `COPY` straight into a `bigint[]` column with **no transformation**.
  An empty array is an empty (unquoted) field, which `COPY … (FORMAT csv)`
  reads as `NULL` — so model these columns as nullable and `coalesce(…, '{}')`
  in derive, or add `FORCE_NOT_NULL` and a default.
- **Nulls are unquoted empty fields** (`,,`). Strings are quoted only when they
  contain a comma, quote, or newline. Standard RFC 4180, so
  `COPY … (FORMAT csv, HEADER true)` handles it natively.
- **Timestamps are `YYYY-MM-DD HH:MM:SS`** (e.g. `2022-04-08 00:00:00`), not
  epoch seconds. Note the contrast: `updated_at` in the `/dumps` _listing_ is
  epoch seconds, but `updated_at`/`created_at`/`first_release_date` _inside the
  CSV_ are formatted timestamps. They cast directly to `timestamptz` (assume
  UTC).
- **Column order in the CSV is not the alphabetical order of the `schema`
  object.** Always drive the column mapping off the header row.
- **`summary` and `storyline` contain embedded newlines.** Never count rows or
  split records by line; always use a real CSV parser (or `COPY`).
- **`category` is present but empty on every row.** It is the deprecated name
  for `game_type`, retained as a column for compatibility. **Do not mirror it**;
  mirror `game_type` only.
- **`hypes`, `total_rating_count`, `rating_count`, `follows` all exist**, so the
  popularity formula in §6.6 works as written. `hypes` is empty for most
  released games, so `coalesce(…, 0)`.
- **`tags` is `INTEGER[]` of bit-packed values** (e.g. `536870913`). Not worth
  decoding; skip the column.
- The games dump has **60 columns**, well beyond what we need. Mirror a subset
  and ignore the rest, but keep `checksum` and `updated_at`.

---

## 13.5 Title relations, added 2026-09-04

The fold hides things. A page has to show what it hid, or the fold reads as
data loss — someone looking for "Blood and Wine" on The Witcher 3's page needs
to see it listed, and someone on The Last of Us needs a route to Part I.

`GET /games/:id` now carries three more fields, all computed at read time from
`title_members` and `igdb_games` rather than stored:

| Field                         | What it answers                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `parent` + `relationToParent` | "This is a **Remake of** The Last of Us"                                         |
| `folded`                      | What was absorbed and given no page: DLC, expansions, remasters, editions, ports |
| `related`                     | Descendants that kept their own page                                             |

**4,108 titles have a parent**: 2,072 expanded editions, 1,461 remakes, 496
standalone expansions, 135 forks.

Read-time joins, not stored columns — `titles` already carries ~370 MB of
avoidable jsonb (§13.3) and these are small indexed lookups against tables the
derive maintains anyway.

**One performance trap worth remembering.** The first version of the
`related` query filtered on `coalesce(version_parent, parent_game)`. There is no
index on that expression, so it sequentially scanned all 374k games on every
page load and took `/games/:id` from 2.0 ms to **28.7 ms** at p50. Testing the
two columns separately — `version_parent in (…)` UNION `version_parent is null
and parent_game in (…)`, which reproduces coalesce's precedence — makes each
branch an index scan: 24.5 ms to 1.4 ms, and the endpoint back to 2.6 ms.
Any future filter over a computed expression deserves an `explain analyze`
before it ships.

**Two display decisions live in the web app, not the API**, because both are
presentation:

- Ports are not rendered. They merge platforms and contribute nothing a reader
  wants listed — "Halo (Xbox 360)" under Halo is noise. They stay in `folded`.
- Members whose name is just the title's own are dropped. **4,430 exist** —
  version children IGDB filed with no version title — and "Includes: Grand Theft
  Auto V" on the Grand Theft Auto V page says nothing.

The API does strip a redundant title prefix from folded names (`shortName`),
since it is the side that holds both strings: "The Witcher 3: Wild Hunt – Blood
and Wine" becomes "Blood and Wine" in a list on that title's own page, with the
full name still on `displayName`. It also reports `parentName` — which member an
entry hangs off, when that is not the title itself.

**`parentName` exists because the fold is transitive**, and that turns out to
matter more than it sounds. World of Warcraft absorbs its expansions, and each
expansion's own Collector's Edition comes up with it: eleven folded editions
arrive, **eight of them named "Collector's Edition"**, and they are eight
different products. Listing them verbatim is noise. Collapsing them to one entry
reads tidily and quietly claims WoW shipped a single Collector's Edition.

`apps/web/src/lib/folded.ts` resolves it: reduce each name to its bare form
(IGDB spells one of them "WoW: Battle for Azeroth - Collector's Edition"), then
qualify **only the ones that still collide**. WoW gets "Cataclysm: Collector's
Edition", "Shadowlands: Collector's Edition" and so on, with the base game's
left bare. Qualifying unconditionally was tried first and was worse — it turned
The Witcher 3's unique "10th Anniversary Edition" into "Complete Edition: 10th
Anniversary Edition" for no benefit.

---

## 14. Open questions

Resolved questions are kept, struck through, with where the answer landed —
the reasoning is usually more useful than the conclusion.

### Open

8. **`similar` needs quoting in every raw query.** `SIMILAR` is a reserved SQL
   keyword (`SIMILAR TO`), so `select …, similar, …` is a syntax error rather
   than a column reference. This has now bitten twice — once in the read layer,
   once in a test fixture. Worth considering a rename to `similar_titles` in a
   later migration; until then, quote it.
9. **Nothing exercises a real IGDB delete yet.** The redirect heuristic and the
   tombstone path are tested against synthetic rows only, because IGDB deleted
   zero games in the days we have observed. The first real delete is worth
   watching: check the `Deleted game redirected` / `several plausible
replacements` log lines and confirm the choice by hand.
10. **`applyDeleteRedirects` caps at 500 games per dump run.** Above that it
    skips the heuristic entirely rather than quietly rewriting where thousands
    of users' records point. If a legitimate bulk merge ever exceeds it, that is
    a manual decision, not a config change.
11. **Consolidation is not wired into the backlog actions.** §7.4 says backlog
    items follow the same policy as game records, and `title-identity.ts` has
    the pieces, but only the game-record actions call it. Backlog items are
    keyed the same way, so the same fold produces the same duplicate.
12. **Profile and feed pages do not group by title yet.** `groupByTitle` exists
    and is unused outside the game page. A profile listing records saved before
    a fold will show the same game twice until they do.
13. **§7.5 (AppView) is untouched.** `GET /games/:id/members` exists now; the
    HappyView backlog query still filters on a single raw `igdbId`, so
    cross-user queries split after a fold. The change belongs in
    `services/appview`.
14. **Schema-version drift is already real.** The ten endpoints report five
    different `schema_version` values, the oldest from 2023 and the newest
    (`covers`) from about three months ago. §5.2's guard fires per endpoint and
    aborts that endpoint alone — verified in Phase 1 — but nobody is alerted
    when it does. Worth surfacing on `/health` alongside the other freshness
    signals.
15. **`titles` carries ~370 MB of avoidable jsonb** (§13.3). Measured in Phase 3
    as buying no read latency: `/games/:id` is 2 ms at p50. Deferred, not
    rejected.
16. **Fly vs Railway** for the scheduled dump job. In-process cron is fine on
    either as long as the machine does not auto-stop; if it does, use a platform
    scheduled task hitting an authenticated `POST /admin/dumps`. Nothing is
    deployed yet, so this is still open.

17. **`dominant` skews light.** It is `sharp`'s histogram dominant, which
    favours large flat areas — usually a cover's pale background. The Witcher 3
    resolves to `#e8f8f8` while the palette's top swatch is `#615e5f`. The web
    app has always used this value so nothing regressed, but if a tint ever
    looks washed out, the palette is the better source and the API already
    returns it.
18. **267k covers have no colours yet.** Only 400 were backfilled locally as a
    smoke test. `deno task colors:backfill` takes about two hours; until it has
    run, the endpoint computes each on first request, which is correct but slow
    for whoever gets there first.

### Resolved

1. ~~**Dump CSV encoding details.**~~ **Phase 0**, see §13.2. Arrays are
   Postgres literals (`{1,2,3}`), nulls are unquoted empty fields, timestamps
   are `YYYY-MM-DD HH:MM:SS`. Direct `COPY` works.
2. ~~**Dashes house style.**~~ **Decided 2026-09-03**: spaced en dash
   (`Title – Subtitle`). Digit ranges get an unspaced en dash.
3. ~~**Whether to typeset `summary`.**~~ **Decided 2026-09-03**: yes,
   `summary_display` ships. Note §13.3 — it is 139 MB and a pure function of
   `summary`, so typesetting on read is a live option if the size matters more
   than the CPU.
4. ~~**Similar games.**~~ **Resolved in Phase 5.** Entries resolving back to the
   same title as the root were already dropped; deleted titles are now excluded
   too.
5. ~~**`hypes` and `total_rating_count` availability.**~~ **Phase 0**: both
   present, with `rating_count` and `follows`. `hypes` is empty for most
   released games, so `coalesce(…, 0)`.
6. ~~**Does the schema-drift guard fire in practice?**~~ **Yes** — see open
   question 14 for what is still missing.
7. ~~**`sharp` in the Docker image.**~~ **Verified 2026-09-04 on both
   architectures.** `deno install` inside `denoland/deno` runs sharp's native
   install script (the build log shows `Initialize sharp@0.34.4`), and the
   approval recorded in `deno.lock` carries into a clean container. Decoding a
   real cover inside the image returns exactly the host's answer —
   `{r:232,g:248,b:248}` — on `linux/arm64` and `linux/amd64` alike. npm's
   optional dependencies pull `@img/sharp-linux-x64` or `-arm64` as
   appropriate, so the Dockerfile needs no apt packages and no changes.

   Two things that cost time here. The first build failed with
   `DeadlineExceeded` pulling the base image — `docker pull denoland/deno:latest`
   separately first, then build. And `docker build … | tail` reports _tail's_
   exit status, so a failed build reads as exit 0; read the output, not `$?`.
