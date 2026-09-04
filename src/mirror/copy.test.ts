import { assertEquals } from 'jsr:@std/assert'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import postgres from 'postgres'
import { config } from '../config.js'

/**
 * How IGDB's CSV actually lands in Postgres.
 *
 * There is no JS coercion layer on the dump path — `COPY … (FORMAT csv)` does
 * all the parsing, because IGDB writes Postgres-native array literals and
 * `YYYY-MM-DD HH:MM:SS` timestamps. That is a nice property but an easy one to
 * break by "helpfully" adding a transform, so the behaviour we depend on is
 * pinned here with real fixtures.
 */

// A dedicated connection rather than the shared app pool, so the test file can
// close it and Deno's resource sanitizer stays happy.
const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

type Row = Record<string, unknown>

/** Index into COPY results without tripping `noUncheckedIndexedAccess`. */
function row(rows: Row[], index = 0): Row {
	const found = rows[index]
	if (!found) throw new Error(`Expected a row at index ${index}, got ${rows.length} rows`)
	return found
}

async function copyFixture(columns: string, csv: string): Promise<Row[]> {
	const table = `copy_test_${crypto.randomUUID().replaceAll('-', '')}`
	await sql.unsafe(`create unlogged table "${table}" (${columns})`)
	const writable = await sql
		.unsafe(`copy "${table}" from stdin (format csv, header true)`)
		.writable()
	await pipeline(Readable.from([csv]), writable)
	const rows = await sql.unsafe(`select * from "${table}" order by id`)
	await sql.unsafe(`drop table "${table}"`)
	return rows as unknown as Row[]
}

Deno.test('LONG[] arrives as a Postgres array literal', async () => {
	const rows = await copyFixture(
		'id bigint, platforms bigint[]',
		'id,platforms\n1,"{6,14,130}"\n2,{48}\n',
	)
	// Values, not shape, is the point here: `{6,14,130}` needs no transform.
	assertEquals((row(rows, 0).platforms as string[]).map(Number), [6, 14, 130])
	assertEquals((row(rows, 1).platforms as string[]).map(Number), [48])
})

Deno.test('bigints come back from the driver as STRINGS', async () => {
	// postgres.js will not narrow int8 to a JS number on its own, since int8 is
	// wider than Number.MAX_SAFE_INTEGER. IGDB ids are nowhere near that, but the
	// driver does not know it, so raw-SQL callers get `'1942'` and `['6','14']`.
	// Drizzle's `bigint({ mode: 'number' })` converts; hand-written SQL in the
	// derive layer must convert too, or `id === 1942` silently never matches.
	const rows = await copyFixture('id bigint, platforms bigint[]', 'id,platforms\n1942,"{6,14}"\n')
	assertEquals(row(rows).id, '1942')
	assertEquals(row(rows).platforms, ['6', '14'])
})

Deno.test('an empty array field is NULL, not an empty array', async () => {
	// The distinction that bites: IGDB writes nothing at all for "no platforms",
	// and CSV has no way to say "empty array". Derive must coalesce.
	const rows = await copyFixture('id bigint, platforms bigint[]', 'id,platforms\n1,\n')
	assertEquals(row(rows, 0).platforms, null)
})

Deno.test('unquoted empty is NULL but quoted empty is an empty string', async () => {
	const rows = await copyFixture('id bigint, name text', 'id,name\n1,\n2,""\n')
	assertEquals(row(rows, 0).name, null)
	assertEquals(row(rows, 1).name, '')
})

Deno.test('quoted strings carry commas, quotes and newlines', async () => {
	const rows = await copyFixture(
		'id bigint, summary text',
		'id,summary\n1,"WARHAMMER 40,000"\n2,"He said ""go""."\n3,"line one\nline two"\n',
	)
	assertEquals(row(rows, 0).summary, 'WARHAMMER 40,000')
	assertEquals(row(rows, 1).summary, 'He said "go".')
	assertEquals(row(rows, 2).summary, 'line one\nline two')
})

Deno.test('timestamps are formatted, not epoch seconds', async () => {
	const rows = await copyFixture(
		'id bigint, first_release_date timestamptz',
		'id,first_release_date\n1,2022-04-08 00:00:00\n2,\n',
	)
	assertEquals((row(rows, 0).first_release_date as Date).toISOString(), '2022-04-08T00:00:00.000Z')
	assertEquals(row(rows, 1).first_release_date, null)
})

Deno.test('booleans are t/f', async () => {
	const rows = await copyFixture(
		'id bigint, developer boolean, publisher boolean, supporting boolean',
		'id,developer,publisher,supporting\n1,t,f,\n',
	)
	assertEquals(row(rows, 0).developer, true)
	assertEquals(row(rows, 0).publisher, false)
	assertEquals(row(rows, 0).supporting, null)
})

Deno.test('checksums are UUIDs and doubles keep their fraction', async () => {
	const rows = await copyFixture(
		'id bigint, rating double precision, checksum uuid',
		'id,rating,checksum\n1,78.5813,43e91be1-592f-c3be-3e1d-447b3f17584c\n',
	)
	assertEquals(row(rows, 0).rating, 78.5813)
	assertEquals(row(rows, 0).checksum, '43e91be1-592f-c3be-3e1d-447b3f17584c')
})

Deno.test('COPY matches fields positionally, so header order is what counts', async () => {
	// The header is skipped, not read. A staging table built in the wrong order
	// silently loads the wrong data into the wrong columns — which is why the
	// loader builds staging from the file's own header.
	const rows = await copyFixture('id bigint, a text, b text', 'id,b,a\n1,first,second\n')
	assertEquals(row(rows, 0).a, 'first')
	assertEquals(row(rows, 0).b, 'second')
})

Deno.test('close the connection', async () => {
	await sql.end()
})
