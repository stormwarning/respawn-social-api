import { assertEquals } from 'jsr:@std/assert'
import { typeset } from '../derive/typeset.js'
import { normalize } from './normalize.js'

Deno.test('normalize folds accents', () => {
	assertEquals(normalize('Pokémon'), 'pokemon')
	assertEquals(normalize('Ōkami'), 'okami')
	assertEquals(normalize('Brütal Legend'), 'brutal legend')
})

Deno.test('normalize folds every quote shape onto ASCII', () => {
	assertEquals(normalize('Don’t Starve'), "don't starve")
	assertEquals(normalize("Don't Starve"), "don't starve")
	assertEquals(normalize('“Quoted”'), '"quoted"')
})

Deno.test('normalize folds every dash shape onto a hyphen', () => {
	assertEquals(normalize('Title – Subtitle'), 'title - subtitle')
	assertEquals(normalize('Title — Subtitle'), 'title - subtitle')
	assertEquals(normalize('Title - Subtitle'), 'title - subtitle')
})

Deno.test('normalize strips zero-width characters', () => {
	assertEquals(normalize('\uFEFFThe Flooded Tower'), 'the flooded tower')
})

Deno.test('normalize collapses whitespace and trims', () => {
	assertEquals(normalize('  Half   Life  '), 'half life')
})

Deno.test('normalize is idempotent', () => {
	for (const input of ['Pokémon', 'Don’t Starve', 'Title – Subtitle', '  a  b  ']) {
		const once = normalize(input)
		assertEquals(normalize(once), once)
	}
})

Deno.test('typeset never changes what a title normalizes to', () => {
	// The property the search layer depends on: display text and matching text
	// must stay interchangeable, or applying smart punctuation would silently
	// make titles unfindable.
	const titles = [
		"Don't Starve",
		"Assassin's Creed",
		"'90s Arcade Racer",
		"Rock 'n' Roll Racing",
		'Title - Subtitle',
		'Title -- Subtitle',
		'2019-2020',
		'"Quoted" Title',
		'Wait...',
		'Half-Life 2: Episode One',
	]
	for (const title of titles) {
		assertEquals(normalize(typeset(title)), normalize(title), `diverged on ${title}`)
	}
})
