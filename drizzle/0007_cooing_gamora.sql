-- The IGDB read-through cache is gone.
--
-- `games` held one folded IGDB payload per game we had ever served, refreshed
-- lazily with 3-4 live IGDB calls per cold miss. `search_cache` held whole
-- IGDB search responses keyed by query string. Both are replaced by the
-- derived `titles` / `title_members` / `title_terms` tables, which are built
-- from the local mirror and need no IGDB call at all.
--
-- The parity check in Phase 2 compared all 560 cached rows against the derived
-- titles before this ran; results are recorded in docs/PLAN-igdb-mirror.md §12.
DROP TABLE "games" CASCADE;--> statement-breakpoint
DROP TABLE "search_cache" CASCADE;