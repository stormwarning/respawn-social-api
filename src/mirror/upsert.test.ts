import { assertEquals } from 'jsr:@std/assert'
import postgres from 'postgres'
import { config } from '../config.js'
import { coerce } from './upsert.js'

/**
 * IGDB's JSON API and its CSV dumps disagree about how values are written, and
 * both feed the same canonical tables. Everything here is a difference that has
 * actually caused a bug.
 */

Deno.test('TIMESTAMP: JSON epoch seconds, CSV formatted date', () => {
	// The trap. IGDB's JSON sends 1431993600; reading that as milliseconds dates
	// The Witcher 3 to January 1970.
	assertEquals(coerce('TIMESTAMP', 1431993600), '2015-05-19T00:00:00.000Z')
	assertEquals(coerce('TIMESTAMP', '2015-05-19 00:00:00'), '2015-05-19T00:00:00.000Z')
})

Deno.test('TIMESTAMP is a string, never a Date', () => {
	// postgres.js cannot serialize a Date through its dynamic-object insert; it
	// falls back to the string serializer and throws ERR_INVALID_ARG_TYPE.
	assertEquals(typeof coerce('TIMESTAMP', 1431993600), 'string')
})

Deno.test('TIMESTAMP: an unparseable value is null, not Invalid Date', () => {
	assertEquals(coerce('TIMESTAMP', 'not a date'), null)
})

Deno.test('numbers arrive as numbers or as numeric strings', () => {
	assertEquals(coerce('LONG', 1942), 1942)
	assertEquals(coerce('LONG', '1942'), 1942)
	assertEquals(coerce('INTEGER', '7'), 7)
	assertEquals(coerce('DOUBLE', '78.58'), 78.58)
})

Deno.test('BOOLEAN: JSON true/false, CSV t/f', () => {
	assertEquals(coerce('BOOLEAN', true), true)
	assertEquals(coerce('BOOLEAN', 't'), true)
	assertEquals(coerce('BOOLEAN', 'f'), false)
	assertEquals(coerce('BOOLEAN', false), false)
})

Deno.test('arrays of ids', () => {
	assertEquals(coerce('LONG[]', [6, 14, 130]), [6, 14, 130])
	assertEquals(coerce('INTEGER[]', ['1', '2']), [1, 2])
})

Deno.test('an expanded relation is reduced to its id', () => {
	// A caller asking IGDB for `platforms.name` gets objects back. We only ever
	// store the id, and the derive layer joins for the name.
	assertEquals(coerce('LONG[]', [{ id: 6, name: 'PC' }, { id: 48 }]), [6, 48])
})

Deno.test('missing values are null, including the empty string', () => {
	for (const type of ['LONG', 'STRING', 'TIMESTAMP', 'BOOLEAN', 'LONG[]'] as const) {
		assertEquals(coerce(type, null), null, `${type} null`)
		assertEquals(coerce(type, undefined), null, `${type} undefined`)
		assertEquals(coerce(type, ''), null, `${type} empty string`)
	}
})

Deno.test('a non-array for an array column is null, not a crash', () => {
	assertEquals(coerce('LONG[]', 5), null)
})

// ---------------------------------------------------------------------------
// Round trip against the real table.
// ---------------------------------------------------------------------------

const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

// An id far outside IGDB's range, so a real dump load can never collide.
const TEST_ID = 999_000_111

Deno.test('upsertEntity inserts, skips unchanged, and revives a tombstone', async () => {
	const { markDeleted, upsertEntity } = await import('./upsert.js')

	await sql`delete from igdb_genres where id = ${TEST_ID}`

	const row = {
		id: TEST_ID,
		name: 'Test Genre',
		slug: 'test-genre',
		url: 'https://example.test',
		created_at: 1431993600,
		updated_at: 1431993600,
		checksum: '00000000-0000-0000-0000-000000000001',
	}

	assertEquals((await upsertEntity('genres', row)).changed, true)

	const [inserted] = await sql<Array<{ name: string; created_at: Date | string }>>`
		select name, created_at from igdb_genres where id = ${TEST_ID}
	`
	assertEquals(inserted?.name, 'Test Genre')
	assertEquals(new Date(inserted!.created_at).toISOString(), '2015-05-19T00:00:00.000Z')

	// Same checksum: a no-op, so `mirror_updated_at` keeps meaning "last moved".
	assertEquals((await upsertEntity('genres', row)).changed, false)

	// New checksum: a real change.
	const changed = { ...row, name: 'Renamed', checksum: '00000000-0000-0000-0000-000000000002' }
	assertEquals((await upsertEntity('genres', changed)).changed, true)
	const [updated] = await sql<Array<{ name: string }>>`
		select name from igdb_genres where id = ${TEST_ID}
	`
	assertEquals(updated?.name, 'Renamed')

	// Deleting is a tombstone, never a removal: PDS records still point here.
	await markDeleted('genres', TEST_ID)
	const [tombstoned] = await sql<Array<{ deleted_at: Date | null }>>`
		select deleted_at from igdb_genres where id = ${TEST_ID}
	`
	assertEquals(tombstoned?.deleted_at !== null, true)

	// A row that reappears upstream is revived even though its checksum matches.
	assertEquals((await upsertEntity('genres', changed)).changed, true)
	const [revived] = await sql<Array<{ deleted_at: Date | null }>>`
		select deleted_at from igdb_genres where id = ${TEST_ID}
	`
	assertEquals(revived?.deleted_at, null)

	await sql`delete from igdb_genres where id = ${TEST_ID}`
})

Deno.test('close the connection', async () => {
	await sql.end()
})
