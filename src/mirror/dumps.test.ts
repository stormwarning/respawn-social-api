import { assertEquals } from 'jsr:@std/assert'
import { parseHeader } from './dumps.js'
import { checkSchema } from './dumps.js'

Deno.test('parseHeader splits a plain header', () => {
	assertEquals(parseHeader('id,name,slug'), ['id', 'name', 'slug'])
})

Deno.test('parseHeader tolerates CRLF', () => {
	assertEquals(parseHeader('id,name\r'), ['id', 'name'])
})

Deno.test('parseHeader honours quoting', () => {
	assertEquals(parseHeader('id,"a,b","say ""hi"""'), ['id', 'a,b', 'say "hi"'])
})

Deno.test('parseHeader keeps empty trailing fields', () => {
	assertEquals(parseHeader('id,,name'), ['id', '', 'name'])
})

Deno.test('checkSchema passes when every mirrored column matches', () => {
	assertEquals(
		checkSchema('genres', {
			id: 'LONG',
			name: 'STRING',
			created_at: 'TIMESTAMP',
			updated_at: 'TIMESTAMP',
			slug: 'STRING',
			url: 'STRING',
			checksum: 'UUID',
		}),
		[],
	)
})

Deno.test('checkSchema ignores columns IGDB adds upstream', () => {
	const problems = checkSchema('genres', {
		id: 'LONG',
		name: 'STRING',
		created_at: 'TIMESTAMP',
		updated_at: 'TIMESTAMP',
		slug: 'STRING',
		url: 'STRING',
		checksum: 'UUID',
		brand_new_column: 'STRING',
	})
	assertEquals(problems, [])
})

Deno.test('checkSchema reports a removed mirrored column', () => {
	const problems = checkSchema('genres', {
		id: 'LONG',
		name: 'STRING',
		created_at: 'TIMESTAMP',
		updated_at: 'TIMESTAMP',
		url: 'STRING',
		checksum: 'UUID',
	})
	assertEquals(problems, ['column "slug" is gone from the dump'])
})

Deno.test('checkSchema reports a retyped mirrored column', () => {
	const problems = checkSchema('genres', {
		id: 'LONG',
		name: 'STRING',
		created_at: 'TIMESTAMP',
		updated_at: 'TIMESTAMP',
		slug: 'LONG',
		url: 'STRING',
		checksum: 'UUID',
	})
	assertEquals(problems, ['column "slug" is now LONG, was STRING'])
})
