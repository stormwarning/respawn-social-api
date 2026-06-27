import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { games, searchCache } from '../db/schema.js'
import { logger } from '../logger.js'
import { SingleFlight } from '../lib/single-flight.js'
import { igdbRequest } from './client.js'
import { foldRelations, GAME_FIELDS, type IgdbGame, resolveRootGame } from './fold.js'

export type { IgdbGame }

/**
 * IGDB data layer (the read-through cache).
 *
 * Backend concept: "read-through cache with stale-while-revalidate (SWR)".
 * Callers (our API routes) ONLY talk to this file — never to IGDB directly.
 *
 * For each lookup we:
 *   1. Check Postgres (our mirror). If the row is fresh -> return it. Zero IGDB calls.
 *   2. If the row is stale -> return the stale copy IMMEDIATELY, and refresh in
 *      the background (SWR). The user never waits on IGDB.
 *   3. If there's no row at all -> fetch from IGDB (deduped via single-flight),
 *      store it, and return it.
 *
 * Net effect: a popular game is fetched from IGDB essentially once, ever.
 */

// How long a cached game is considered "fresh". Game metadata changes rarely,
// so a week is comfortable. Stale rows are still served (then refreshed).
const GAME_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
// Search results are more volatile; cache them for a few hours.
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

// One single-flight registry per concern, so identical concurrent requests dedupe.
const gameFlight = new SingleFlight<IgdbGame | null>()
const searchFlight = new SingleFlight<IgdbGame[]>()

function isFresh(fetchedAt: Date, ttlMs: number): boolean {
	return Date.now() - fetchedAt.getTime() < ttlMs
}

/** Map an IGDB game payload to a `games` table row. */
function toGameRow(game: IgdbGame) {
	return {
		id: game.id,
		slug: game.slug ?? null,
		payload: game,
		checksum: game.checksum ?? null,
	}
}

/** Upsert a game into the mirror, keyed by IGDB id. */
async function upsertGame(game: IgdbGame): Promise<void> {
	const row = toGameRow(game)
	await db
		.insert(games)
		.values(row)
		.onConflictDoUpdate({
			target: games.id,
			set: {
				slug: row.slug,
				payload: row.payload,
				checksum: row.checksum,
				fetchedAt: new Date(),
			},
		})
}

/** Pull a single game from IGDB (by id) and upsert it into the mirror. */
async function fetchAndStoreGame(id: number): Promise<IgdbGame | null> {
	const rows = await igdbRequest<IgdbGame[]>('games', `fields ${GAME_FIELDS}; where id = ${id};`)
	const game = rows[0]
	if (!game) return null
	// Resolve foldable/never types up to their primary title, then collapse
	// related titles into it before storing.
	const root = await resolveRootGame(game, igdbRequest)
	const folded = await foldRelations(root, igdbRequest)
	await upsertGame(folded)
	return folded
}

/** Pull a single game from IGDB (by slug) and upsert it into the mirror. */
async function fetchAndStoreGameBySlug(slug: string): Promise<IgdbGame | null> {
	// Escape double-quotes to keep the apicalypse query well-formed.
	const safe = slug.replace(/"/g, '\\"')
	const rows = await igdbRequest<IgdbGame[]>(
		'games',
		`fields ${GAME_FIELDS}; where slug = "${safe}";`,
	)
	const game = rows[0]
	if (!game) return null
	const root = await resolveRootGame(game, igdbRequest)
	const folded = await foldRelations(root, igdbRequest)
	await upsertGame(folded)
	return folded
}

/**
 * Get a game by its IGDB id, served from cache when possible.
 */
export async function getGame(id: number): Promise<IgdbGame | null> {
	const row = await db.query.games.findFirst({ where: eq(games.id, id) })

	if (row) {
		const cached = row.payload as IgdbGame
		if (isFresh(row.fetchedAt, GAME_TTL_MS)) {
			return cached // fresh hit — no IGDB call
		}
		// Stale: serve now, refresh in the background (stale-while-revalidate).
		void gameFlight
			.run(`game:${id}`, () => fetchAndStoreGame(id))
			.catch((err) => logger.error(err, `Background refresh failed for game ${id}`))
		return cached
	}

	// Cold miss: must fetch. Deduped so concurrent callers share one IGDB request.
	return gameFlight.run(`game:${id}`, () => fetchAndStoreGame(id))
}

/**
 * Get a game by its IGDB slug, served from cache when possible. Mirrors
 * getGame()'s stale-while-revalidate logic but keys lookups on the slug column.
 */
export async function getGameBySlug(slug: string): Promise<IgdbGame | null> {
	const row = await db.query.games.findFirst({ where: eq(games.slug, slug) })

	if (row) {
		const cached = row.payload as IgdbGame
		if (isFresh(row.fetchedAt, GAME_TTL_MS)) {
			return cached // fresh hit — no IGDB call
		}
		// Stale: serve now, refresh in the background (stale-while-revalidate).
		void gameFlight
			.run(`slug:${slug}`, () => fetchAndStoreGameBySlug(slug))
			.catch((err) => logger.error(err, `Background refresh failed for game slug ${slug}`))
		return cached
	}

	// Cold miss: must fetch. Deduped so concurrent callers share one IGDB request.
	return gameFlight.run(`slug:${slug}`, () => fetchAndStoreGameBySlug(slug))
}

/** Normalize a search query so "Zelda " and "zelda" share a cache entry. */
function normalizeQuery(q: string): string {
	return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Run an IGDB search and cache the results. */
async function fetchAndStoreSearch(normalized: string): Promise<IgdbGame[]> {
	// Escape double-quotes to keep the apicalypse query well-formed.
	const safe = normalized.replace(/"/g, '\\"')
	const results = await igdbRequest<IgdbGame[]>(
		'games',
		// Only surface primary + "keep as separate" titles (main, standalone
		// expansion, remake, expanded game, fork). Foldable + never-show types
		// are excluded from search/nav.
		`search "${safe}"; fields ${GAME_FIELDS}; where version_parent = null & game_type = (0,4,8,10,12); limit 20;`,
	)

	const now = new Date()
	await db
		.insert(searchCache)
		.values({
			query: normalized,
			results,
			fetchedAt: now,
			expiresAt: new Date(now.getTime() + SEARCH_TTL_MS),
		})
		.onConflictDoUpdate({
			target: searchCache.query,
			set: {
				results,
				fetchedAt: now,
				expiresAt: new Date(now.getTime() + SEARCH_TTL_MS),
			},
		})

	// Opportunistically warm the per-game mirror too, so a later getGame() is free.
	for (const game of results) {
		void db
			.insert(games)
			.values(toGameRow(game))
			.onConflictDoNothing()
			.catch(() => {})
	}

	return results
}

/**
 * Search games by title, served from cache when possible.
 */
export async function searchGames(query: string): Promise<IgdbGame[]> {
	const normalized = normalizeQuery(query)
	if (!normalized) return []

	const row = await db.query.searchCache.findFirst({
		where: eq(searchCache.query, normalized),
	})

	if (row && row.expiresAt.getTime() > Date.now()) {
		return row.results as IgdbGame[] // fresh hit
	}

	// Miss or expired: fetch (deduped). We don't SWR searches — just refetch,
	// since a stale search list is less useful than a stale single game.
	return searchFlight.run(`search:${normalized}`, () => fetchAndStoreSearch(normalized))
}
