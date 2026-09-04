-- Trigram search over the title terms.
--
-- This replaces IGDB's `search` endpoint and the `search_cache` table. A GIN
-- trigram index answers both the fuzzy match (`term_norm % $q`) and the prefix
-- match (`term_norm like $q || '%'`) from the same structure, which is why the
-- ranking query in §8.3 can do one scan instead of two.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "title_terms_term_norm_trgm" ON "title_terms" USING gin ("term_norm" gin_trgm_ops);
