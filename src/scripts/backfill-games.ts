import { asc, gte, sql as raw } from 'drizzle-orm'
import { db, sql } from '../db/client.js'
import { games, searchCache } from '../db/schema.js'
import { fetchAndStoreGame } from '../igdb/data.js'
import { logger } from '../logger.js'

/**
 * One-shot backfill for the game mirror.
 *
 * Backend concept: a "cache rewrite". `games.payload` stores the IGDB response
 * verbatim, so whenever GAME_FIELDS or the fold layer changes, rows written
 * before that change keep serving the old shape until their 7-day TTL lapses —
 * and even then stale-while-revalidate hands the OLD payload to the first
 * visitor. This script walks every mirrored row and re-runs it through the
 * current fetch + fold pipeline (`fetchAndStoreGame`), so the whole cache is
 * consistent with today's code.
 *
 * Every IGDB call still goes through the shared rate-limited queue in
 * `igdb/client.ts`. When running this against a database a live server is also
 * using, set IGDB_RATE_CAP=1 so the two processes together stay under IGDB's
 * global 4 req/s.
 *
 *   deno task db:backfill                # everything not already backfilled
 *   deno task db:backfill --limit 5      # smoke test
 *   deno task db:backfill --from 12345   # resume after an interrupted run
 *   deno task db:backfill --force        # redo rows even if they look current
 *
 * Safe to re-run: rows that already carry the new fields are skipped.
 */

// How many games we work on at once. Only feeds the request queue — that queue,
// not this number, is what keeps us under IGDB's limit.
const CONCURRENCY = 5

interface Options {
	force: boolean
	from?: number
	limit?: number
}

function parseArgs(argv: string[]): Options {
	const options: Options = { force: false }

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--force') {
			options.force = true
		} else if (arg === '--from' || arg === '--limit') {
			const value = Number(argv[++i])
			if (!Number.isInteger(value) || value <= 0) {
				throw new Error(`${arg} requires a positive integer`)
			}
			if (arg === '--from') options.from = value
			else options.limit = value
		} else {
			throw new Error(`Unknown argument: ${arg}`)
		}
	}

	return options
}

/** Ids to rewrite, oldest id first so `--from` can resume where a run stopped. */
async function selectIds(options: Options): Promise<number[]> {
	const conditions = []
	if (options.from !== undefined) conditions.push(gte(games.id, options.from))
	// A row that already has a slug on its first similar_games entry was written
	// by the current code path. Games with no similar_games at all can't be told
	// apart this way, so they get refetched on every run (harmless, and rare).
	if (!options.force) {
		conditions.push(raw`not (${games.payload}->'similar_games'->0 ? 'slug')`)
	}

	const rows = await db
		.select({ id: games.id })
		.from(games)
		.where(conditions.length > 0 ? raw.join(conditions, raw` and `) : undefined)
		.orderBy(asc(games.id))
		.limit(options.limit ?? Number.MAX_SAFE_INTEGER)

	return rows.map((r) => r.id)
}

async function main() {
	const options = parseArgs(Deno.args)

	const total = await db.$count(games)
	const ids = await selectIds(options)
	logger.info(
		`Backfill: ${ids.length} of ${total} mirrored games to rewrite ` +
			`(concurrency ${CONCURRENCY}, force=${options.force})`,
	)

	let done = 0
	let missing = 0
	const failed: number[] = []

	// Shared cursor: each worker pulls the next id until the list is exhausted.
	let cursor = 0
	const worker = async () => {
		while (cursor < ids.length) {
			const id = ids[cursor++]
			if (id === undefined) break

			try {
				const game = await fetchAndStoreGame(id)
				if (game) {
					done++
				} else {
					// IGDB no longer returns this id (game removed/merged). Leave the
					// existing row alone rather than deleting data we can't re-fetch.
					missing++
					logger.warn(`Game ${id} not found on IGDB; left as-is`)
				}
			} catch (err) {
				failed.push(id)
				logger.error(err, `Backfill failed for game ${id}`)
			}

			const seen = done + missing + failed.length
			if (seen % 25 === 0) logger.info(`  ...${seen}/${ids.length}`)
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker))

	// Search results embed whole game objects, so they carry the same stale shape.
	// They have a 6h TTL and rebuild on demand — cheapest fix is to drop them.
	const cleared = await db.delete(searchCache)
	logger.info(`Cleared ${cleared.count} cached search result(s)`)

	logger.info(
		`Backfill complete: ${done} rewritten, ${missing} missing on IGDB, ${failed.length} failed`,
	)
	if (failed.length > 0) {
		logger.error(`Failed ids: ${failed.join(',')}`)
	}

	await sql.end()
	if (failed.length > 0) process.exit(1)
}

main().catch(async (err) => {
	logger.error(err, 'Backfill failed')
	await sql.end().catch(() => {})
	process.exit(1)
})
