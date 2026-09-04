import { assertEquals } from 'jsr:@std/assert'
import { typeset } from './typeset.js'

/** Every case in §6.4 of docs/PLAN-igdb-mirror.md. */
const CASES: Array<[input: string, expected: string, rule: string]> = [
	["Don't Starve", 'Don’t Starve', 'apostrophe between letters'],
	["Assassin's Creed", 'Assassin’s Creed', 'possessive'],
	["'90s Arcade Racer", '’90s Arcade Racer', 'leading elision before a digit'],
	["Rock 'n' Roll Racing", 'Rock ’n’ Roll Racing', 'elision on both sides'],
	['"Quoted" Title', '“Quoted” Title', 'paired double quotes'],
	['Half-Life', 'Half-Life', 'hyphen between letters is untouched'],
	['2019-2020', '2019–2020', 'digits both sides -> en dash, unspaced'],
	['Title - Subtitle', 'Title – Subtitle', 'spaced hyphen -> spaced en dash'],
	['Title -- Subtitle', 'Title – Subtitle', 'double hyphen -> en dash'],
	['Wait...', 'Wait…', 'ellipsis'],
	['Title  :  Sub', 'Title: Sub', 'collapse space, none before a colon'],
	['  Padded  ', 'Padded', 'trim'],
	['5\'11"', '5′11″', 'primes'],
]

for (const [input, expected, rule] of CASES) {
	Deno.test(`typeset: ${rule} (${JSON.stringify(input)})`, () => {
		assertEquals(typeset(input), expected)
	})
}

Deno.test('typeset is idempotent over every case', () => {
	for (const [input] of CASES) {
		const once = typeset(input)
		assertEquals(typeset(once), once, `not idempotent: ${JSON.stringify(input)}`)
	}
})

Deno.test('typeset leaves already-smart text alone', () => {
	const smart = 'Already ’ smart – here'
	assertEquals(typeset(smart), smart)
})

Deno.test('typeset handles real IGDB titles', () => {
	assertEquals(typeset("Marvel's Spider-Man"), 'Marvel’s Spider-Man')
	assertEquals(typeset("Tom Clancy's Rainbow Six Siege"), 'Tom Clancy’s Rainbow Six Siege')
	assertEquals(typeset("Baldur's Gate 3"), 'Baldur’s Gate 3')
	assertEquals(typeset("Sid Meier's Civilization VI"), 'Sid Meier’s Civilization VI')
	// A colon subtitle is the common case and must survive untouched.
	assertEquals(typeset('The Witcher 3: Wild Hunt'), 'The Witcher 3: Wild Hunt')
	assertEquals(typeset('Half-Life 2: Episode One'), 'Half-Life 2: Episode One')
})

Deno.test('a matched single-quote pair is quotation, not two apostrophes', () => {
	// Straight from the catalogue: The Witcher 3's DLC list.
	assertEquals(
		typeset("The Witcher 3: Wild Hunt - New Quest 'Contract: Skellige's Most Wanted'"),
		'The Witcher 3: Wild Hunt – New Quest ‘Contract: Skellige’s Most Wanted’',
	)
	assertEquals(typeset("New Quest 'Fool's Gold'"), 'New Quest ‘Fool’s Gold’')
	assertEquals(typeset("a 'quoted phrase' here"), 'a ‘quoted phrase’ here')
})

Deno.test('an unmatched single quote stays an apostrophe', () => {
	assertEquals(typeset("'Splosion Man"), '’Splosion Man')
	assertEquals(typeset("Players' Choice"), 'Players’ Choice')
})

Deno.test('typeset does not mangle version-range titles', () => {
	assertEquals(typeset('FIFA 2019-2020 Season Update'), 'FIFA 2019–2020 Season Update')
})

Deno.test('typeset on empty and whitespace-only input', () => {
	assertEquals(typeset(''), '')
	assertEquals(typeset('   '), '')
})
