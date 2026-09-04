import { assertEquals } from 'jsr:@std/assert'
import postgres from 'postgres'
import { config } from '../config.js'
import {
	ensureCoverColors,
	extractCoverColors,
	getCoverColors,
	isValidImageId,
	pendingCoverCount,
} from './colors.js'

const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

// A real IGDB cover (The Witcher 3), used for the one test that needs a decode.
const REAL_COVER = 'coaarl'
const TEST_TITLE = 999_400_001
const TEST_IMAGE = 'zztestcover'

async function cleanup() {
	await sql`delete from cover_colors where image_id in (${TEST_IMAGE}, 'zzzznotreal')`
	await sql`delete from title_members where title_id = ${TEST_TITLE}`
	await sql`delete from titles where id = ${TEST_TITLE}`
}

Deno.test('image ids are validated before they reach a URL', () => {
	assertEquals(isValidImageId('coaarl'), true)
	assertEquals(isValidImageId('co1rs4'), true)

	// The id goes straight into a fetch URL, so anything that could steer that
	// request has to be rejected rather than escaped.
	assertEquals(isValidImageId('../../etc/passwd'), false)
	assertEquals(isValidImageId('co1rs4.jpg'), false)
	assertEquals(isValidImageId('co 1rs4'), false)
	assertEquals(isValidImageId('co/1rs4'), false)
	assertEquals(isValidImageId(''), false)
	assertEquals(isValidImageId('a'), false)
	assertEquals(isValidImageId('x'.repeat(33)), false)
})

Deno.test('a cover that does not exist yields null, not an error', async () => {
	// A missing cover is a data gap. Throwing would turn it into a failed page
	// load for the sake of a tint.
	assertEquals(await extractCoverColors('zzzznotreal'), null)
})

Deno.test('an invalid id never reaches the network', async () => {
	assertEquals(await extractCoverColors('../secrets'), null)
})

Deno.test('a real cover yields a hex dominant and a grouped palette', async () => {
	const colors = await extractCoverColors(REAL_COVER)
	assertEquals(colors?.imageId, REAL_COVER)
	assertEquals(/^#[0-9a-f]{6}$/.test(colors?.dominant ?? ''), true)

	// The palette buckets near-identical pixels together, so at least one entry
	// covers several pixels. Without that grouping every population is 1 and the
	// palette says nothing — which is what the first version did.
	const palette = colors?.palette ?? []
	assertEquals(palette.length > 0, true)
	assertEquals(
		palette.every((p) => /^#[0-9a-f]{6}$/.test(p.hex)),
		true,
	)
	assertEquals(
		palette.some((p) => p.population > 1),
		true,
	)
	// Most frequent first.
	assertEquals(
		palette.every((p, i) => i === 0 || p.population <= palette[i - 1]!.population),
		true,
	)
})

Deno.test('ensureCoverColors stores on a miss and reads back on a hit', async () => {
	await cleanup()
	await sql`delete from cover_colors where image_id = ${REAL_COVER}`

	assertEquals(await getCoverColors(REAL_COVER), null)

	const computed = await ensureCoverColors(REAL_COVER)
	assertEquals(computed?.dominant !== undefined, true)

	// The second call must not decode again — the id is content addressed, so a
	// stored answer can never be stale.
	const stored = await getCoverColors(REAL_COVER)
	assertEquals(stored?.dominant, computed?.dominant)
	assertEquals(stored?.palette?.length, computed?.palette?.length)
})

Deno.test('the pending set is only live titles without colours', async () => {
	await cleanup()
	// Asserted as a delta rather than by looking for the id in a page of
	// results: there are a quarter of a million pending covers and the set is
	// ordered, so a synthetic id may sit well past any reasonable limit.
	const before = await pendingCoverCount()

	await sql`
		insert into titles (
			id, slug, name, display_name, game_type, cover_image_id, platforms, genres,
			developers, publishers, editions, expansions_normalized, extra_cover_image_ids,
			"similar", websites, external_games, status, source_hash, derive_version
		) values (
			${TEST_TITLE}, 'colors-test', 'Colors Test', 'Colors Test', 0, ${TEST_IMAGE},
			'[]', '[]', '{}', '{}', '{}', '{}', '{}', '[]', '[]', '[]', 'live', 'h', 1
		)
	`
	assertEquals(await pendingCoverCount(), before + 1)

	await sql`
		insert into cover_colors (image_id, dominant, palette)
		values (${TEST_IMAGE}, '#123456', null)
	`
	// Once a cover has colours it drops out — which is why the pending set is a
	// query and not a queue: there is no state to keep in sync.
	assertEquals(await pendingCoverCount(), before)

	await sql`delete from cover_colors where image_id = ${TEST_IMAGE}`
	assertEquals(await pendingCoverCount(), before + 1)

	await sql`update titles set status = 'deleted' where id = ${TEST_TITLE}`
	// A tombstoned title is nobody's page; do not spend a fetch on it.
	assertEquals(await pendingCoverCount(), before)

	await cleanup()
})

Deno.test('close the connection', async () => {
	await cleanup()
	await sql.end()
})
