DROP INDEX "titles_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "titles_slug_live_idx" ON "titles" USING btree ("slug") WHERE "titles"."status" = 'live';--> statement-breakpoint
CREATE INDEX "titles_slug_idx" ON "titles" USING btree ("slug");