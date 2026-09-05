-- The browse pages: most popular first, optionally within one year or decade.
--
-- Partial on status so the tombstones never enter the scan, and ordered the
-- way the query orders, so a page is an index range rather than a sort over
-- the whole live catalogue.
CREATE INDEX "titles_browse_popularity_idx" ON "titles" USING btree ("popularity" DESC NULLS LAST) WHERE "titles"."status" = 'live';--> statement-breakpoint
CREATE INDEX "titles_browse_year_idx" ON "titles" USING btree ("release_year","popularity" DESC NULLS LAST) WHERE "titles"."status" = 'live';