import { assertEquals } from 'jsr:@std/assert'
import postgres from 'postgres'
import { config } from '../config.js'
import { applyDeleteRedirect } from '../mirror/redirect.js'
import { resolveTitle, resolveTitles } from './resolve.js'

/**
 * Identity is the part of the system with a real cost of being wrong: a user's
 * rating attached to the wrong game, or a saved record showing a 404. None of
 * that surfaces as an error, so every case is pinned here against real rows.
 *
 * Ids are far outside IGDB's range so a dump load can never collide.
 */

const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

const ROOT = 999_300_001
const DLC = 999_300_002
const DUPLICATE = 999_300_003
const NEVER_MIRRORED = 999_399_999

async function cleanup() {
	const ids = [ROOT, DLC, DUPLICATE]
	await sql`delete from title_terms where title_id = any(${ids})`
	await sql`delete from title_members where game_id = any(${ids}) or title_id = any(${ids})`
	await sql`delete from titles where id = any(${ids})`
	await sql`delete from dirty_titles where title_id = any(${ids})`
	await sql`delete from igdb_games where id = any(${ids})`
}

/**
 * A base game with a DLC folded into it, plus a live title row — the shape a
 * real derive would leave behind.
 */
async function seed(options: { titleStatus?: 'live' | 'deleted' } = {}) {
	await cleanup()
	const status = options.titleStatus ?? 'live'

	await sql`
		insert into igdb_games (id, name, slug, game_type, first_release_date, checksum)
		values
			(${ROOT}, 'Resolve Test Game', 'resolve-test-game', 0, '2020-05-01', gen_random_uuid()),
			(${DLC}, 'Resolve Test DLC', 'resolve-test-dlc', 1, '2020-06-01', gen_random_uuid())
	`
	await sql`update igdb_games set parent_game = ${ROOT} where id = ${DLC}`
	await sql`
		insert into titles (
			id, slug, name, display_name, game_type, release_year, platforms, genres,
			developers, publishers, editions, expansions_normalized,
			extra_cover_image_ids,
			-- "similar" quoted: SIMILAR is a reserved keyword (SIMILAR TO).
			"similar", websites, external_games, status, source_hash, derive_version
		) values (
			${ROOT}, 'resolve-test-game', 'Resolve Test Game', 'Resolve Test Game', 0, 2020,
			'[]', '[]', '{}', '{}', '{}', '{}', '{}', '[]', '[]', '[]',
			${status}, 'test-hash', 1
		)
	`
	await sql`
		insert into title_members (game_id, title_id, fold_type)
		values (${ROOT}, ${ROOT}, 'root'), (${DLC}, ${ROOT}, 'dlc')
	`
	await sql`
		insert into title_terms (title_id, term, term_norm, kind, weight)
		values (${ROOT}, 'Resolve Test Game', 'resolve test game', 'root_name', 'A')
	`
}

Deno.test('a root resolves to itself and reads as live', async () => {
	await seed()
	assertEquals(await resolveTitle(ROOT), { titleId: ROOT, status: 'live', via: 'members' })
	await cleanup()
})

Deno.test('a folded member resolves to its title', async () => {
	await seed()
	// The whole point: a record saved against the DLC lands on the base game.
	assertEquals(await resolveTitle(DLC), { titleId: ROOT, status: 'folded', via: 'members' })
	await cleanup()
})

Deno.test('an id we never mirrored is unknown, not deleted', async () => {
	// The distinction matters: 'unknown' is what tells the read path to try the
	// live IGDB fallback, while 'tombstone' means we already know it is gone.
	const result = await resolveTitle(NEVER_MIRRORED)
	assertEquals(result.via, 'unknown')
	assertEquals(result.titleId, null)
})

Deno.test('a tombstoned title still resolves, so its page can render', async () => {
	await seed({ titleStatus: 'deleted' })
	await sql`update igdb_games set deleted_at = now() where id = ${ROOT}`
	const result = await resolveTitle(ROOT)
	// The title id survives even though the game is gone — a user who logged it
	// should see what they logged, not a 404.
	assertEquals(result.titleId, ROOT)
	assertEquals(result.status, 'deleted')
	await cleanup()
})

Deno.test('a redirect beats a tombstone', async () => {
	await seed()
	await sql`
		insert into igdb_games (id, name, slug, game_type, checksum)
		values (${DUPLICATE}, 'Resolve Test Game', 'resolve-test-game-dup', 0, gen_random_uuid())
	`
	await sql`update igdb_games set deleted_at = now(), redirect_game_id = ${ROOT} where id = ${DUPLICATE}`

	// This is the ordering §7.1 gets wrong. A deleted game keeps its member rows,
	// so "members first, then redirect" would serve the tombstone and never
	// consult the redirect — for exactly the case redirects exist to handle.
	const result = await resolveTitle(DUPLICATE)
	assertEquals(result.titleId, ROOT)
	assertEquals(result.via, 'redirect')
	assertEquals(result.status, 'live')
	await cleanup()
})

Deno.test('a redirect to nowhere falls back rather than resolving to null', async () => {
	await seed()
	await sql`
		insert into igdb_games (id, name, slug, game_type, checksum)
		values (${DUPLICATE}, 'Orphan Redirect', 'orphan-redirect', 0, gen_random_uuid())
	`
	await sql`
		update igdb_games set deleted_at = now(), redirect_game_id = ${NEVER_MIRRORED}
		where id = ${DUPLICATE}
	`
	const result = await resolveTitle(DUPLICATE)
	assertEquals(result.titleId, null)
	assertEquals(result.status, 'deleted')
	await cleanup()
})

Deno.test('resolving many ids returns one entry each', async () => {
	await seed()
	const results = await resolveTitles([ROOT, DLC, NEVER_MIRRORED, ROOT])
	// Duplicates collapse; every distinct id gets an answer.
	assertEquals(results.size, 3)
	assertEquals(results.get(ROOT)?.titleId, ROOT)
	assertEquals(results.get(DLC)?.titleId, ROOT)
	assertEquals(results.get(NEVER_MIRRORED)?.titleId, null)
	await cleanup()
})

Deno.test('resolving nothing is not an error', async () => {
	assertEquals((await resolveTitles([])).size, 0)
})

// ---------------------------------------------------------------------------
// The delete heuristic (§7.3)
// ---------------------------------------------------------------------------

Deno.test('a deleted duplicate redirects to its survivor by name and year', async () => {
	await seed()
	// Accented, so it normalizes to the same string but shares no lowercase
	// prefix — the case a SQL prefix filter is structurally blind to.
	await sql`
		insert into igdb_games (id, name, slug, game_type, first_release_date, checksum)
		values (${DUPLICATE}, 'Resólve Test Game', 'resolve-test-game-dup', 0, '2020-05-01', gen_random_uuid())
	`
	await sql`update igdb_games set deleted_at = now() where id = ${DUPLICATE}`

	const result = await applyDeleteRedirect(DUPLICATE)
	assertEquals(result.redirectTo, ROOT)
	assertEquals(result.reason, 'name+year')
	await cleanup()
})

Deno.test('a candidate with no release year is not accepted as a duplicate', async () => {
	await seed()
	await sql`update titles set release_year = null where id = ${ROOT}`
	await sql`
		insert into igdb_games (id, name, slug, game_type, first_release_date, checksum)
		values (${DUPLICATE}, 'Resolve Test Game', 'resolve-test-game-dup', 0, '2020-05-01', gen_random_uuid())
	`
	await sql`update igdb_games set deleted_at = now() where id = ${DUPLICATE}`

	// Absence of a date is not evidence of a match. A tombstone is recoverable;
	// a wrong redirect quietly moves someone's rating to another game.
	assertEquals((await applyDeleteRedirect(DUPLICATE)).redirectTo, null)
	await cleanup()
})

Deno.test('a different release year is not a duplicate', async () => {
	await seed()
	// Same name, twelve years apart: a remake and its original, not a merge.
	await sql`
		insert into igdb_games (id, name, slug, game_type, first_release_date, checksum)
		values (${DUPLICATE}, 'Resolve Test Game', 'resolve-test-game-remake', 0, '2032-05-01', gen_random_uuid())
	`
	await sql`update igdb_games set deleted_at = now() where id = ${DUPLICATE}`

	const result = await applyDeleteRedirect(DUPLICATE)
	assertEquals(result.redirectTo, null)
	await cleanup()
})

Deno.test('an unrelated deleted game gets no redirect', async () => {
	await seed()
	await sql`
		insert into igdb_games (id, name, slug, game_type, checksum)
		values (${DUPLICATE}, 'Nothing Like The Others', 'nothing-like', 0, gen_random_uuid())
	`
	await sql`update igdb_games set deleted_at = now() where id = ${DUPLICATE}`

	const result = await applyDeleteRedirect(DUPLICATE)
	assertEquals(result.redirectTo, null)
	assertEquals(result.reason, 'none')
	await cleanup()
})

Deno.test('close the connection', async () => {
	await cleanup()
	await sql.end()
})
