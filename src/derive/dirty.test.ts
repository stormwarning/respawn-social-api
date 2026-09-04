import { assertEquals, assertRejects } from 'jsr:@std/assert'
import postgres from 'postgres'
import { config } from '../config.js'
import { markDirtyForIds } from './dirty.js'

/**
 * Dirty propagation is the part of freshness with no visible failure mode: get
 * the mapping wrong and nothing errors, a title just quietly stays stale. So
 * the mapping rules are pinned here against real rows.
 */

const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

// Outside IGDB's id range, so a dump load can never collide with these.
const ROOT = 999_100_001
const DLC = 999_100_002
const COVER = 999_100_003

async function seed() {
	await cleanup()
	await sql`
		insert into igdb_games (id, name, slug, game_type, checksum)
		values (${ROOT}, 'Dirty Test Root', 'dirty-test-root', 0, gen_random_uuid()),
		       (${DLC}, 'Dirty Test DLC', 'dirty-test-dlc', 1, gen_random_uuid())
	`
	await sql`update igdb_games set parent_game = ${ROOT} where id = ${DLC}`
	await sql`
		insert into igdb_covers (id, game, image_id, checksum)
		values (${COVER}, ${ROOT}, 'dirtytestcover', gen_random_uuid())
	`
	// The DLC folds into the root, exactly as a real derive would have recorded.
	await sql`
		insert into title_members (game_id, title_id, fold_type)
		values (${ROOT}, ${ROOT}, 'root'), (${DLC}, ${ROOT}, 'dlc')
	`
	await sql`delete from dirty_titles where title_id = ${ROOT}`
}

/** Derived rows included: a worker running elsewhere may have built a title. */
async function cleanup() {
	await sql`delete from dirty_titles where title_id in (${ROOT}, ${DLC})`
	await sql`delete from title_terms where title_id in (${ROOT}, ${DLC})`
	await sql`delete from title_members where game_id in (${ROOT}, ${DLC})
	          or title_id in (${ROOT}, ${DLC})`
	await sql`delete from titles where id in (${ROOT}, ${DLC})`
	await sql`delete from igdb_covers where id = ${COVER}`
	await sql`delete from igdb_games where id in (${ROOT}, ${DLC})`
}

async function dirtyIds(): Promise<number[]> {
	const rows = await sql<Array<{ title_id: string }>>`
		select title_id from dirty_titles where title_id in (${ROOT}, ${DLC})
	`
	return rows.map((r) => Number(r.title_id)).sort()
}

Deno.test('a changed member queues its title, not itself', async () => {
	await seed()
	// The DLC changed. What has to be rebuilt is the title it folds into —
	// queueing the DLC's own id would rebuild a title that does not exist.
	assertEquals((await markDirtyForIds('games', [DLC], 'test:member')) > 0, true)
	assertEquals(await dirtyIds(), [ROOT])
	await cleanup()
})

Deno.test('a changed root queues itself', async () => {
	await seed()
	await markDirtyForIds('games', [ROOT], 'test:root')
	assertEquals(await dirtyIds(), [ROOT])
	await cleanup()
})

Deno.test('a changed cover queues the game its row points at', async () => {
	await seed()
	// Child tables carry no title id; the mapping has to go through `game`.
	await markDirtyForIds('covers', [COVER], 'test:cover')
	assertEquals(await dirtyIds(), [ROOT])
	await cleanup()
})

Deno.test('a game with no member row queues itself as a new title', async () => {
	await seed()
	await sql`delete from title_members where game_id = ${ROOT}`
	await sql`delete from dirty_titles where title_id = ${ROOT}`
	await markDirtyForIds('games', [ROOT], 'test:new')
	assertEquals(await dirtyIds(), [ROOT])
	await cleanup()
})

Deno.test('queueing is idempotent', async () => {
	await seed()
	await markDirtyForIds('games', [ROOT], 'test:once')
	await markDirtyForIds('games', [ROOT], 'test:twice')
	// The primary key collapses repeats, so a burst of webhooks for one game
	// leaves one row of work rather than N.
	assertEquals(await dirtyIds(), [ROOT])
	await cleanup()
})

Deno.test('unknown ids queue nothing', async () => {
	await seed()
	assertEquals(await markDirtyForIds('games', [999_999_998], 'test:unknown'), 0)
	assertEquals(await dirtyIds(), [])
	await cleanup()
})

Deno.test('a reason that could carry SQL is refused', async () => {
	// The reason is inlined rather than bound (postgres.js types `unsafe`
	// parameters as `never` for an untyped client), so the validation is what
	// stands between this and injection.
	await assertRejects(
		() => markDirtyForIds('games', [ROOT], "x'; drop table titles; --"),
		Error,
		'Unexpected dirty reason',
	)
})

Deno.test('close the connection', async () => {
	await cleanup()
	await sql.end()
})
