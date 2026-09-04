import { bigint, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Layer 1 (canonical) — the `igdb_*` mirror tables, generated from
 * src/mirror/endpoints.ts. Re-exported so `import * as schema` picks them up.
 */
export * from './schema.mirror.js'

/**
 * Layers 2 and 3 — hand-authored overrides, and the derived tables the API
 * actually serves.
 */
export * from './schema.derived.js'

/**
 * Database schema (Drizzle).
 *
 * Backend concept: this file is the single source of truth for our tables.
 * `deno task db:generate` diffs this against the last migration and writes SQL to
 * ./drizzle; `deno task db:migrate` applies that SQL to Postgres. We never hand-edit
 * the database — we edit this file and regenerate.
 */

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

/**
 * One row per dump endpoint, recording the last load.
 *
 * Two jobs. `updated_at` (IGDB's epoch-seconds stamp from `GET /v4/dumps`) lets
 * a nightly run skip an endpoint whose dump hasn't been regenerated. And
 * `schema_version` is the drift tripwire: when IGDB changes an endpoint's
 * column set it bumps this, and the loader refuses to touch that table until a
 * human has looked at it. Five of the ten endpoints already carry different
 * schema versions, so this fires in practice, not just in theory.
 */
export const dumpRuns = pgTable('dump_runs', {
	// The IGDB endpoint name, e.g. "games".
	endpoint: text('endpoint').primaryKey(),
	// e.g. "1788328800_games.csv".
	fileName: text('file_name'),
	// IGDB's epoch-seconds stamp for when the dump was generated.
	updatedAt: bigint('updated_at', { mode: 'number' }),
	schemaVersion: text('schema_version'),
	rowsLoaded: integer('rows_loaded'),
	rowsChanged: integer('rows_changed'),
	rowsDeleted: integer('rows_deleted'),
	loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
})
