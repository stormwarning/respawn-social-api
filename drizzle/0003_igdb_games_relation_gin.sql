-- Reverse lookups over the fold relation arrays.
--
-- Forward walks ("what does this root fold in?") just read the array off the
-- root row. These indexes are for the other direction: when a child game
-- changes we need "which root lists this id?" to mark the right title dirty,
-- and not every child carries a usable `parent_game`.
CREATE INDEX IF NOT EXISTS "igdb_games_dlcs_gin" ON "igdb_games" USING gin ("dlcs");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_expansions_gin" ON "igdb_games" USING gin ("expansions");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_standalone_expansions_gin" ON "igdb_games" USING gin ("standalone_expansions");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_expanded_games_gin" ON "igdb_games" USING gin ("expanded_games");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_forks_gin" ON "igdb_games" USING gin ("forks");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_ports_gin" ON "igdb_games" USING gin ("ports");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_remakes_gin" ON "igdb_games" USING gin ("remakes");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_remasters_gin" ON "igdb_games" USING gin ("remasters");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_bundles_gin" ON "igdb_games" USING gin ("bundles");
