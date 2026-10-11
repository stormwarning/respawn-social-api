CREATE TABLE "detected_plays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"did" text NOT NULL,
	"provider" text NOT NULL,
	"external_game_id" text NOT NULL,
	"external_game_source" bigint NOT NULL,
	"external_name" text,
	"minutes" integer NOT NULL,
	"played_on" date NOT NULL,
	"last_played_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"log_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "detected_plays_day" UNIQUE("account_id","external_game_id","played_on")
);
--> statement-breakpoint
CREATE TABLE "linked_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"did" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"baseline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_accounts_external" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "play_snapshots" (
	"account_id" uuid NOT NULL,
	"external_game_id" text NOT NULL,
	"playtime_minutes" integer NOT NULL,
	"last_played_at" timestamp with time zone,
	CONSTRAINT "play_snapshots_account_id_external_game_id_pk" PRIMARY KEY("account_id","external_game_id")
);
--> statement-breakpoint
ALTER TABLE "detected_plays" ADD CONSTRAINT "detected_plays_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_snapshots" ADD CONSTRAINT "play_snapshots_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "detected_plays_did_status_idx" ON "detected_plays" USING btree ("did","status");--> statement-breakpoint
CREATE INDEX "linked_accounts_did_idx" ON "linked_accounts" USING btree ("did");