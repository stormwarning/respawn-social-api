CREATE TABLE "igdb_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"op" text NOT NULL,
	"entity_id" bigint NOT NULL,
	"checksum" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "igdb_events_delivery" UNIQUE("endpoint","entity_id","checksum","op")
);
--> statement-breakpoint
CREATE INDEX "igdb_events_received_at_idx" ON "igdb_events" USING btree ("received_at");