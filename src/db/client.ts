import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config.js'
import { logger } from '../logger.js'
import * as schema from './schema.js'

/**
 * Database client.
 *
 * Backend concept: a "connection pool". Opening a new Postgres connection per
 * request is slow, so we keep a small pool of reusable connections open for the
 * life of the process. `db` is imported everywhere we need to query.
 *
 * We export `sql` (the raw postgres-js client) too, for the rare cases we want
 * to run something outside Drizzle (e.g. the migrator).
 */
const sql = postgres(config.DATABASE_URL, {
	max: 10, // pool size
	// IGDB writes UTC timestamps with no zone ("2015-05-19 00:00:00"), and
	// Postgres resolves a bare datetime against the SESSION's TimeZone when
	// casting to timestamptz. A per-statement `set time zone` is not enough —
	// the pool hands out whichever connection is free — so it goes in the
	// startup parameters, where every connection inherits it. Without this the
	// same dump loads different release dates in dev and prod.
	connection: { TimeZone: 'UTC' },
	// Postgres NOTICEs ("table ... does not exist, skipping") are routine for the
	// dump loader's idempotent DDL. Keep them out of stdout but not off the record.
	onnotice: (notice) => logger.debug({ notice }, 'postgres notice'),
})

export const db = drizzle(sql, { schema })
export { sql, schema }
