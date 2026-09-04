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
	// Postgres NOTICEs ("table ... does not exist, skipping") are routine for the
	// dump loader's idempotent DDL. Keep them out of stdout but not off the record.
	onnotice: (notice) => logger.debug({ notice }, 'postgres notice'),
})

export const db = drizzle(sql, { schema })
export { sql, schema }
