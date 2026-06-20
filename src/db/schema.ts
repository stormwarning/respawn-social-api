import { bigint, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Database schema (Drizzle).
 *
 * Backend concept: this file is the single source of truth for our tables.
 * `deno task db:generate` diffs this against the last migration and writes SQL to
 * ./drizzle; `deno task db:migrate` applies that SQL to Postgres. We never hand-edit
 * the database — we edit this file and regenerate.
 */

/**
 * The IGDB game mirror.
 *
 * This is the heart of the "don't hammer IGDB" strategy. Every game we fetch
 * gets upserted here keyed by its IGDB id. Future reads come from THIS table,
 * not IGDB. `fetched_at` lets us know when a row is stale enough to refresh;
 * `checksum` is IGDB's own change-hash so we can detect if anything changed.
 */
export const games = pgTable('games', {
	// IGDB's numeric id is our primary key (not an auto-generated one).
	id: bigint('id', { mode: 'number' }).primaryKey(),
	// The full IGDB JSON payload, stored verbatim. jsonb = queryable JSON.
	payload: jsonb('payload').notNull(),
	// IGDB's change-detection hash (uuid string).
	checksum: text('checksum'),
	// When we last pulled this from IGDB (drives stale-while-revalidate).
	fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Cached search results.
 *
 * Searches are the risky, high-volume case. We cache them keyed by the
 * normalized query string. Short TTL (search results change more than a single
 * game's details). `expires_at` is checked on read.
 */
export const searchCache = pgTable('search_cache', {
	// The normalized query string (lowercased/trimmed) is the key.
	query: text('query').primaryKey(),
	// Array of game results (JSON).
	results: jsonb('results').notNull(),
	fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

/**
 * The Twitch/IGDB OAuth token (single row).
 *
 * IGDB auth gives us one app-level access token that lasts ~weeks. We persist
 * it so a server restart doesn't force a fresh token fetch. Only ever one row
 * (id = "igdb").
 */
export const oauthToken = pgTable('oauth_token', {
	id: text('id').primaryKey(), // always "igdb"
	accessToken: text('access_token').notNull(),
	// When the token becomes invalid (so we refresh slightly before).
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
