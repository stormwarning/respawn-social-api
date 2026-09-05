import { assertEquals } from 'jsr:@std/assert'
import postgres from 'postgres'
import { config } from '../config.js'
import { browseTitles } from './read.js'

/**
 * The browse pages are the catalogue's front door, so the filter arithmetic —
 * a decade's inclusive bounds, a tombstone leaking into the count, a page past
 * the end — is pinned here against real rows rather than trusted.
 *
 * Ids are far outside IGDB's range so a dump load can never collide. They are
 * also far *above* anything real, and the ordering tiebreak is on id, so the
 * seeded rows never interleave with live catalogue rows of equal popularity
 * (zero) in an unfiltered browse — which is why the unfiltered case is not
 * tested: its page one is whatever the mirror holds.
 */

const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

// A year no real title can share, so the year filter isolates the seed.
const YEAR = 2091
const DECADE = 2090

const SEED = [
	{ id: 999_310_001, year: YEAR, popularity: 50, status: 'live' },
	{ id: 999_310_002, year: YEAR, popularity: 500, status: 'live' },
	{ id: 999_310_003, year: YEAR, popularity: 5, status: 'live' },
	{ id: 999_310_004, year: YEAR, popularity: 9999, status: 'deleted' },
	{ id: 999_310_005, year: DECADE, popularity: 1, status: 'live' },
	{ id: 999_310_006, year: DECADE + 9, popularity: 2, status: 'live' },
	{ id: 999_310_007, year: DECADE + 10, popularity: 3, status: 'live' },
] as const

const ids = SEED.map((row) => row.id)

async function cleanup() {
	await sql`delete from titles where id = any(${ids})`
}

async function seed() {
	await cleanup()
	for (const row of SEED) {
		await sql`
			insert into titles (id, slug, name, display_name, game_type, release_year,
			                    platforms, genres, developers, publishers, editions,
			                    expansions_normalized, extra_cover_image_ids, "similar",
			                    websites, external_games, popularity, status,
			                    source_hash, derive_version)
			values (${row.id}, ${`browse-test-${row.id}`}, ${`Browse ${row.id}`},
			        ${`Browse ${row.id}`}, 0, ${row.year},
			        '[]', '[]', '{}', '{}', '{}', '{}', '{}', '[]', '[]', '[]',
			        ${row.popularity}, ${row.status}, 'test', 0)
		`
	}
}

Deno.test('browseTitles', async (t) => {
	await seed()
	try {
		await t.step('filters to one year, most popular first, skipping tombstones', async () => {
			const result = await browseTitles({ year: YEAR, page: 1, limit: 24 })
			assertEquals(result.total, 3)
			assertEquals(
				result.items.map((item) => item.id),
				[999_310_002, 999_310_001, 999_310_003],
			)
		})

		await t.step('a decade is inclusive of its first and last year', async () => {
			const result = await browseTitles({ decade: DECADE, page: 1, limit: 24 })
			assertEquals(result.total, 5)
			const found = result.items.map((item) => item.id)
			assertEquals(found.includes(999_310_005), true)
			assertEquals(found.includes(999_310_006), true)
			assertEquals(found.includes(999_310_007), false)
		})

		await t.step('pages by limit and offset, reporting the total across pages', async () => {
			const second = await browseTitles({ year: YEAR, page: 2, limit: 2 })
			assertEquals(second.total, 3)
			assertEquals(second.page, 2)
			assertEquals(second.pageSize, 2)
			assertEquals(
				second.items.map((item) => item.id),
				[999_310_003],
			)
		})

		await t.step('a page past the end is empty with a zero total', async () => {
			const result = await browseTitles({ year: YEAR, page: 9, limit: 24 })
			assertEquals(result.items, [])
			assertEquals(result.total, 0)
		})

		await t.step('shapes each item as a title summary with a big cover', async () => {
			await sql`update titles set cover_image_id = 'co1abc' where id = ${999_310_002}`
			const result = await browseTitles({ year: YEAR, page: 1, limit: 1 })
			assertEquals(
				result.items[0]?.coverUrl,
				'https://images.igdb.com/igdb/image/upload/t_cover_big/co1abc.jpg',
			)
			assertEquals(result.items[0]?.releaseYear, YEAR)
			assertEquals(result.items[0]?.platforms, [])
		})
	} finally {
		await cleanup()
		await sql.end()
	}
})
