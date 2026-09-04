-- Stop mirroring release dates.
--
-- 583k rows and 114 MB, loaded every night since Phase 1 and read by nothing.
-- A title's date comes from `igdb_games.first_release_date`; the per-platform
-- breakdown in this table was never wired to anything. Removing it also takes
-- ~4s off each nightly dump load.
--
-- Recoverable: add `release_dates` back to src/mirror/endpoints.ts, regenerate,
-- and one dump load refills it.
DROP TABLE "igdb_release_dates" CASCADE;
