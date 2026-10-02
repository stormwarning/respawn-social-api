import { sql } from '../db/client.js'

/**
 * Resolving a saved IGDB id to the title it belongs to now — §7.1 of
 * docs/PLAN-igdb-mirror.md.
 *
 * User records live in PDS repos we do not own and cannot rewrite. They are
 * keyed by whatever IGDB id was current when the user saved them, and IGDB
 * reorganises: a standalone game becomes a DLC of another, a duplicate entry is
 * deleted in favour of its twin, an edition folds into its base game. Every one
 * of those leaves someone holding an id that no longer names a title.
 *
 * So resolution happens at READ time, on every request, and never as a
 * migration. Four ways an id can land:
 *
 *   members  — the id is in `title_members`. The normal case, and it covers
 *              both a root and anything folded into one.
 *   redirect — the game was deleted and we worked out what replaced it (§7.3).
 *   tombstone— the game was deleted and we did not. The title, if it still has
 *              one, renders from last known data rather than 404ing.
 *   unknown  — never mirrored. The caller can try the §5.5 live fallback.
 */

export type ResolveStatus = 'live' | 'folded' | 'deleted'
export type ResolveVia = 'members' | 'redirect' | 'tombstone' | 'unknown'

export interface ResolveResult {
	titleId: number | null
	status: ResolveStatus
	via: ResolveVia
	/** Set when `via` is 'redirect': the id we followed to get here. */
	redirectedFrom?: number
}

/** Guard against a redirect chain that loops or wanders. */
const MAX_REDIRECT_HOPS = 4

/**
 * Resolve many ids at once.
 *
 * Batched deliberately: a profile page holds a hundred game records, and one
 * query per record would make resolution cost more than everything else the
 * page does. Three queries total, regardless of how many ids come in.
 */
export async function resolveTitles(ids: number[], hop = 0): Promise<Map<number, ResolveResult>> {
	const out = new Map<number, ResolveResult>()
	if (ids.length === 0) return out

	const unique = [...new Set(ids)]

	// 1. Membership, joined to the title so a tombstoned title is not reported
	//    as live just because its member rows survive.
	const members = await sql<
		Array<{ game_id: string; title_id: string; fold_type: string; status: string | null }>
	>`
		select m.game_id, m.title_id, m.fold_type, t.status
		from title_members m
		left join titles t on t.id = m.title_id
		where m.game_id = any(${unique})
	`

	// A live title is the answer. A DELETED one is not yet: the game may have a
	// redirect recorded, and §7.1's order (members, then redirect) would never
	// reach it — a deleted root keeps its member rows, so membership always wins
	// and the redirect is unreachable for precisely the case it exists for.
	const tombstoned: Array<{ id: number; titleId: number }> = []
	for (const row of members) {
		const gameId = Number(row.game_id)
		const titleId = Number(row.title_id)
		if (row.status === 'deleted') {
			tombstoned.push({ id: gameId, titleId })
			continue
		}
		out.set(gameId, {
			titleId,
			status: row.fold_type === 'root' ? 'live' : 'folded',
			via: 'members',
		})
	}

	// 2. Whatever is left is either deleted, redirected, or was never ours.
	const unresolved = unique.filter((id) => !out.has(id))
	if (unresolved.length === 0) return out

	const games = await sql<
		Array<{ id: string; redirect_game_id: string | null; deleted_at: Date | string | null }>
	>`
		select id, redirect_game_id, deleted_at from igdb_games where id = any(${unresolved})
	`
	const byId = new Map(games.map((g) => [Number(g.id), g]))
	const tombstonedTitle = new Map(tombstoned.map((t) => [t.id, t.titleId]))

	const followed: Array<{ from: number; to: number }> = []
	for (const id of unresolved) {
		const game = byId.get(id)
		const fallbackTitle = tombstonedTitle.get(id) ?? null

		if (!game) {
			out.set(id, {
				titleId: fallbackTitle,
				status: 'deleted',
				via: fallbackTitle === null ? 'unknown' : 'tombstone',
			})
			continue
		}

		if (game.redirect_game_id !== null && hop < MAX_REDIRECT_HOPS) {
			followed.push({ from: id, to: Number(game.redirect_game_id) })
			continue
		}
		if (game.redirect_game_id !== null) {
			// A chain this long is a cycle or a data problem, not a merge history.
			// Stop rather than recurse: the caller gets the tombstone, which is
			// honest, instead of a hang.
			out.set(id, { titleId: fallbackTitle, status: 'deleted', via: 'tombstone' })
			continue
		}

		// Mirrored, no redirect: a tombstone (whose title we keep serving from
		// last known data), or a type we never ingest at all.
		out.set(id, { titleId: fallbackTitle, status: 'deleted', via: 'tombstone' })
	}

	// 3. Follow redirects. Recursion rather than a loop over the whole batch,
	//    because a redirect target can itself be a folded member.
	if (followed.length > 0) {
		const targets = await resolveTitles(
			followed.map((f) => f.to),
			hop + 1,
		)
		for (const { from, to } of followed) {
			const target = targets.get(to)
			if (target?.titleId != null) {
				out.set(from, {
					titleId: target.titleId,
					status: target.status,
					via: 'redirect',
					redirectedFrom: to,
				})
			} else {
				// The redirect led nowhere useful; fall back to the tombstone so the
				// user still sees the game they saved rather than nothing.
				out.set(from, {
					titleId: tombstonedTitle.get(from) ?? null,
					status: 'deleted',
					via: 'tombstone',
				})
			}
		}
	}

	return out
}

export async function resolveTitle(id: number): Promise<ResolveResult> {
	const results = await resolveTitles([id])
	return results.get(id) ?? { titleId: null, status: 'deleted', via: 'unknown' }
}

export interface ResolveResultWithRelease extends ResolveResult {
	/** The resolved title's first release, ISO; null when unknown, TBA, or unresolved. */
	firstReleaseDate: string | null
}

/**
 * Attach each resolved title's release date.
 *
 * Separate from `resolveTitles` so identity stays about identity: the activity
 * feed needs to hide logs of games that are not out yet, and checks the date
 * fresh on every read because release dates slip.
 */
export async function withReleaseDates(
	results: Map<number, ResolveResult>,
): Promise<Map<number, ResolveResultWithRelease>> {
	const titleIds = [
		...new Set([...results.values()].flatMap((r) => (r.titleId === null ? [] : [r.titleId]))),
	]
	const rows =
		titleIds.length === 0
			? []
			: await sql<Array<{ id: string; first_release_date: Date | string | null }>>`
				select id, first_release_date from titles where id = any(${titleIds})
			`
	const dates = new Map(
		rows.map((row) => [
			Number(row.id),
			row.first_release_date === null ? null : new Date(row.first_release_date).toISOString(),
		]),
	)

	const out = new Map<number, ResolveResultWithRelease>()
	for (const [id, result] of results) {
		const firstReleaseDate = result.titleId === null ? null : (dates.get(result.titleId) ?? null)
		out.set(id, { ...result, firstReleaseDate })
	}
	return out
}
