import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { normalize } from '../search/normalize.js'

/**
 * Working out what replaced a deleted game — §7.3 of docs/PLAN-igdb-mirror.md.
 *
 * IGDB deletions are almost always duplicate merges: two entries for one game,
 * one of them removed. The delete webhook carries only the id, never the
 * survivor, so somebody has to guess — and the guess matters, because users
 * hold records at the deleted id and the alternative is showing them a
 * tombstone of a game that still exists under another number.
 *
 * Two signals, tried in order, and both require EXACTLY ONE match. An ambiguous
 * answer is worse than none: a wrong redirect silently attaches a user's rating
 * to a different game, and there is nothing in the UI that would reveal it. When
 * in doubt we leave it null, keep the tombstone, and a human can add a
 * `fold_overrides` entry later.
 */

export interface RedirectResult {
	gameId: number
	redirectTo: number | null
	reason: 'slug' | 'name+year' | 'ambiguous' | 'none'
	candidates?: number[]
}

/**
 * Find and record where a deleted game's records should point.
 *
 * Call after the row is tombstoned. Safe to re-run: it recomputes from current
 * data and overwrites, so a redirect found today can be corrected by tomorrow's
 * dump.
 */
export async function applyDeleteRedirect(gameId: number): Promise<RedirectResult> {
	const [game] = await sql<
		Array<{ name: string | null; slug: string | null; first_release_date: Date | string | null }>
	>`
		select name, slug, first_release_date from igdb_games where id = ${gameId}
	`
	if (!game) return { gameId, redirectTo: null, reason: 'none' }

	// 1. Slug. IGDB sometimes frees the cleaner slug when it deletes a duplicate
	//    and gives it to the survivor, which makes this an exact, high-confidence
	//    signal — but only when the survivor has actually taken it.
	if (game.slug) {
		const bySlug = await sql<Array<{ id: string }>>`
			select id from igdb_games
			where slug = ${game.slug} and id <> ${gameId} and deleted_at is null
			limit 3
		`
		if (bySlug.length === 1) {
			return record(gameId, Number(bySlug[0]!.id), 'slug')
		}
		if (bySlug.length > 1) {
			return ambiguous(
				gameId,
				bySlug.map((r) => Number(r.id)),
				'slug',
			)
		}
	}

	// 2. Normalized name plus release year, matched through `title_terms`.
	//
	//    The obvious prefilter — comparing a lowercase prefix of the name in SQL
	//    — cannot work, because the difference it has to see through is exactly
	//    the one it is blind to: "Tést Merge Game" and "Test Merge Game"
	//    normalize to the same string but share no lowercase prefix. Postgres has
	//    no NFKD without an extension, so instead we look the normalized name up
	//    in `title_terms`, which derive already populated using the same
	//    `normalize()` the search path uses. One definition, one index.
	if (game.name) {
		const year = game.first_release_date ? new Date(game.first_release_date).getUTCFullYear() : null

		const matches = await sql<Array<{ id: string; release_year: number | null }>>`
			select t.id, t.release_year
			from title_terms tt
			join titles t on t.id = tt.title_id
			where tt.term_norm = ${normalize(game.name)}
			  and tt.kind = 'root_name'
			  and t.status = 'live'
			  and t.id <> ${gameId}
			limit 10
		`

		// When the deleted game has a release year, the survivor must have the
		// SAME one — including having one at all. Two games sharing a name a
		// decade apart are a remake and its original, not a duplicate, and a
		// candidate with no date is not evidence of a match; it is an absence of
		// evidence. Erring towards a tombstone is recoverable, a wrong redirect
		// silently reattaches someone's rating to a different game and is not.
		const sameYear = year === null ? matches : matches.filter((m) => m.release_year === year)

		if (sameYear.length === 1) return record(gameId, Number(sameYear[0]!.id), 'name+year')
		if (sameYear.length > 1) {
			return ambiguous(
				gameId,
				sameYear.map((m) => Number(m.id)),
				'name+year',
			)
		}
	}

	logger.info({ gameId, name: game.name }, 'Deleted game: no redirect target found')
	await clear(gameId)
	return { gameId, redirectTo: null, reason: 'none' }
}

async function record(
	gameId: number,
	redirectTo: number,
	reason: 'slug' | 'name+year',
): Promise<RedirectResult> {
	// A redirect to something itself deleted would strand the user one hop
	// further along, so refuse rather than chain onto a tombstone.
	await sql`
		update igdb_games set redirect_game_id = ${redirectTo}
		where id = ${gameId}
		  and exists (select 1 from igdb_games t where t.id = ${redirectTo} and t.deleted_at is null)
	`
	logger.info({ gameId, redirectTo, reason }, 'Deleted game redirected')
	return { gameId, redirectTo, reason }
}

async function ambiguous(
	gameId: number,
	candidates: number[],
	signal: string,
): Promise<RedirectResult> {
	// Deliberately no redirect. Logged loudly because this is the case a human
	// should look at and settle with a fold_overrides entry.
	logger.warn(
		{ gameId, candidates, signal },
		'Deleted game has several plausible replacements; leaving it a tombstone',
	)
	await clear(gameId)
	return { gameId, redirectTo: null, reason: 'ambiguous', candidates }
}

/** A previously-recorded redirect that no longer holds must not linger. */
async function clear(gameId: number): Promise<void> {
	await sql`update igdb_games set redirect_game_id = null where id = ${gameId}`
}

/**
 * Apply the heuristic to every game tombstoned by a dump load.
 *
 * Capped: a run that would redirect thousands of games is not a merge, it is
 * something going wrong upstream, and quietly rewriting where all those users'
 * records point is exactly what should not happen automatically.
 */
export async function applyDeleteRedirects(gameIds: number[], cap = 500): Promise<number> {
	if (gameIds.length === 0) return 0
	if (gameIds.length > cap) {
		logger.error(
			{ count: gameIds.length, cap },
			'Too many games deleted at once; skipping redirect heuristic entirely',
		)
		return 0
	}

	let redirected = 0
	for (const gameId of gameIds) {
		try {
			const result = await applyDeleteRedirect(gameId)
			if (result.redirectTo !== null) redirected++
		} catch (error) {
			logger.error({ error, gameId }, 'Redirect heuristic failed')
		}
	}
	return redirected
}
