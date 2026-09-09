CREATE TABLE "igdb_game_localizations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"cover" bigint,
	"game" bigint,
	"region" bigint,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"checksum" uuid,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "igdb_game_localizations_game_idx" ON "igdb_game_localizations" USING btree ("game");