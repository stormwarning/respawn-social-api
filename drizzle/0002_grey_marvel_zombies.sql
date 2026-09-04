CREATE TABLE "dump_runs" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"file_name" text,
	"updated_at" bigint,
	"schema_version" text,
	"rows_loaded" integer,
	"rows_changed" integer,
	"rows_deleted" integer,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "igdb_alternative_names" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"comment" text,
	"game" bigint,
	"checksum" uuid,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_companies" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"slug" text,
	"url" text,
	"logo" bigint,
	"description" text,
	"start_date" timestamp with time zone,
	"start_date_category" integer,
	"country" integer,
	"parent" bigint,
	"changed_company_id" bigint,
	"change_date" timestamp with time zone,
	"change_date_category" integer,
	"twitter" text,
	"facebook" text,
	"website" bigint,
	"websites" bigint[],
	"checksum" uuid,
	"status" bigint,
	"start_date_format" bigint,
	"change_date_format" bigint,
	"company_size" bigint,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_covers" (
	"id" bigint PRIMARY KEY NOT NULL,
	"url" text,
	"image_id" text,
	"width" integer,
	"height" integer,
	"alpha_channel" boolean,
	"animated" boolean,
	"game" bigint,
	"checksum" uuid,
	"game_localization" bigint,
	"image_type" bigint,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_external_games" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"uid" text,
	"year" integer,
	"url" text,
	"game" bigint,
	"checksum" uuid,
	"countries" integer[],
	"platform" bigint,
	"media" integer,
	"external_game_source" bigint,
	"game_release_format" bigint,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_games" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"slug" text,
	"url" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"summary" text,
	"storyline" text,
	"collection" bigint,
	"franchise" bigint,
	"franchises" bigint[],
	"hypes" integer,
	"follows" integer,
	"rating" double precision,
	"aggregated_rating" double precision,
	"aggregated_rating_count" integer,
	"total_rating" double precision,
	"total_rating_count" integer,
	"rating_count" integer,
	"parent_game" bigint,
	"version_parent" bigint,
	"version_title" text,
	"similar_games" bigint[],
	"game_engines" bigint[],
	"player_perspectives" bigint[],
	"game_modes" bigint[],
	"keywords" bigint[],
	"themes" bigint[],
	"genres" bigint[],
	"expansions" bigint[],
	"dlcs" bigint[],
	"bundles" bigint[],
	"standalone_expansions" bigint[],
	"first_release_date" timestamp with time zone,
	"status" integer,
	"platforms" bigint[],
	"release_dates" bigint[],
	"alternative_names" bigint[],
	"screenshots" bigint[],
	"videos" bigint[],
	"cover" bigint,
	"websites" bigint[],
	"external_games" bigint[],
	"multiplayer_modes" bigint[],
	"involved_companies" bigint[],
	"age_ratings" bigint[],
	"artworks" bigint[],
	"checksum" uuid,
	"remakes" bigint[],
	"remasters" bigint[],
	"expanded_games" bigint[],
	"ports" bigint[],
	"forks" bigint[],
	"language_supports" bigint[],
	"game_localizations" bigint[],
	"collections" bigint[],
	"game_status" bigint,
	"game_type" bigint,
	"redirect_game_id" bigint,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_genres" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"slug" text,
	"url" text,
	"checksum" uuid,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_involved_companies" (
	"id" bigint PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"game" bigint,
	"company" bigint,
	"publisher" boolean,
	"developer" boolean,
	"supporting" boolean,
	"porting" boolean,
	"checksum" uuid,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_platforms" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"slug" text,
	"url" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"summary" text,
	"platform_family" bigint,
	"alternative_name" text,
	"generation" integer,
	"versions" bigint[],
	"abbreviation" text,
	"platform_logo" bigint,
	"websites" bigint[],
	"checksum" uuid,
	"platform_type" bigint,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_release_dates" (
	"id" bigint PRIMARY KEY NOT NULL,
	"game" bigint,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"platform" bigint,
	"date" timestamp with time zone,
	"region" integer,
	"y" integer,
	"m" integer,
	"human" text,
	"checksum" uuid,
	"status" bigint,
	"date_format" bigint,
	"release_region" bigint,
	"d" integer,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "igdb_websites" (
	"id" bigint PRIMARY KEY NOT NULL,
	"url" text,
	"trusted" boolean,
	"game" bigint,
	"checksum" uuid,
	"type" bigint,
	"mirror_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "igdb_alternative_names_game_idx" ON "igdb_alternative_names" USING btree ("game");--> statement-breakpoint
CREATE INDEX "igdb_covers_game_idx" ON "igdb_covers" USING btree ("game");--> statement-breakpoint
CREATE INDEX "igdb_external_games_game_idx" ON "igdb_external_games" USING btree ("game");--> statement-breakpoint
CREATE INDEX "igdb_external_games_uid_idx" ON "igdb_external_games" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "igdb_games_slug_idx" ON "igdb_games" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "igdb_games_parent_game_idx" ON "igdb_games" USING btree ("parent_game");--> statement-breakpoint
CREATE INDEX "igdb_games_version_parent_idx" ON "igdb_games" USING btree ("version_parent");--> statement-breakpoint
CREATE INDEX "igdb_games_game_type_idx" ON "igdb_games" USING btree ("game_type");--> statement-breakpoint
CREATE INDEX "igdb_games_updated_at_idx" ON "igdb_games" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "igdb_involved_companies_game_idx" ON "igdb_involved_companies" USING btree ("game");--> statement-breakpoint
CREATE INDEX "igdb_involved_companies_company_idx" ON "igdb_involved_companies" USING btree ("company");--> statement-breakpoint
CREATE INDEX "igdb_release_dates_game_idx" ON "igdb_release_dates" USING btree ("game");--> statement-breakpoint
CREATE INDEX "igdb_websites_game_idx" ON "igdb_websites" USING btree ("game");