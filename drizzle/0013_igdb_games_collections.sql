-- Reverse lookup over IGDB's collection ("series") membership.
--
-- A title page asks "what else is in this game's series?", which is the same
-- shape of question the fold-relation indexes answer: given a set of ids, find
-- the rows that list them. `collections` is the current array field; the
-- singular `collection` is IGDB's older scalar, still populated on plenty of
-- rows, so both sides of the lookup need an index or the join falls back to a
-- sequential scan over all 374k games.
CREATE INDEX IF NOT EXISTS "igdb_games_collections_gin" ON "igdb_games" USING gin ("collections");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "igdb_games_collection_idx" ON "igdb_games" USING btree ("collection");
