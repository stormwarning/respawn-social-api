CREATE TABLE "cover_colors" (
	"image_id" text PRIMARY KEY NOT NULL,
	"dominant" text NOT NULL,
	"palette" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dirty_titles" (
	"title_id" bigint PRIMARY KEY NOT NULL,
	"reason" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fold_overrides" (
	"game_id" bigint PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"target_game_id" bigint,
	"note" text NOT NULL,
	CONSTRAINT "fold_overrides_action" CHECK ("fold_overrides"."action" in ('fold_into','keep_separate','hide')),
	CONSTRAINT "fold_overrides_target" CHECK (("fold_overrides"."action" <> 'fold_into') or ("fold_overrides"."target_game_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "genre_aliases" (
	"genre_id" bigint PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overrides_meta" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_aliases" (
	"platform_id" bigint PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "title_members" (
	"game_id" bigint PRIMARY KEY NOT NULL,
	"title_id" bigint NOT NULL,
	"fold_type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "title_patches" (
	"game_id" bigint PRIMARY KEY NOT NULL,
	"patch" jsonb NOT NULL,
	"note" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "title_terms" (
	"title_id" bigint NOT NULL,
	"term" text NOT NULL,
	"term_norm" text NOT NULL,
	"kind" text NOT NULL,
	"weight" char(1) NOT NULL,
	CONSTRAINT "title_terms_title_id_term_norm_kind_pk" PRIMARY KEY("title_id","term_norm","kind")
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"id" bigint PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"summary" text,
	"summary_display" text,
	"game_type" integer NOT NULL,
	"first_release_date" timestamp with time zone,
	"release_year" integer,
	"cover_image_id" text,
	"platforms" jsonb NOT NULL,
	"genres" jsonb NOT NULL,
	"developers" text[] NOT NULL,
	"publishers" text[] NOT NULL,
	"editions" text[] NOT NULL,
	"expansions_normalized" text[] NOT NULL,
	"extra_cover_image_ids" text[] NOT NULL,
	"similar" jsonb NOT NULL,
	"websites" jsonb NOT NULL,
	"external_games" jsonb NOT NULL,
	"popularity" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"source_hash" text NOT NULL,
	"derive_version" integer NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "titles_status" CHECK ("titles"."status" in ('live','deleted'))
);
--> statement-breakpoint
CREATE INDEX "title_members_title_id_idx" ON "title_members" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "title_terms_title_id_idx" ON "title_terms" USING btree ("title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "titles_slug_idx" ON "titles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "titles_status_idx" ON "titles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "titles_popularity_idx" ON "titles" USING btree ("popularity");