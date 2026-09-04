/**
 * Smart punctuation for display text.
 *
 * Pure, deterministic, idempotent. Runs at derive time over `display_name`,
 * `summary_display`, `editions` and `expansions_normalized` — never over
 * `name`, `slug`, or anything in `title_terms`, because matching has to happen
 * on what IGDB actually wrote. See §6.4 of docs/PLAN-igdb-mirror.md.
 *
 * Ported from the regexes in `rehype-typeset`, minus the HTML-entity and
 * non-breaking-space handling, which make no sense for values in a database.
 *
 * House style: a spaced EN dash for `Title - Subtitle`.
 *
 * If a specific title comes out wrong, fix it with `title_patches.display_name`
 * rather than adding a special case here. Every rule below has to hold for
 * 316k titles, and a rule that fixes one title usually breaks a dozen.
 */

const EN_DASH = '–'
const ELLIPSIS = '…'
const APOSTROPHE = '’' // ’
const LEFT_SINGLE = '‘' // ‘
const LEFT_DOUBLE = '“' // “
const RIGHT_DOUBLE = '”' // ”
const PRIME = '′' // ′
const DOUBLE_PRIME = '″' // ″

export function typeset(text: string): string {
	let out = text.replace(/\s+/g, ' ').trim()

	// No space before closing punctuation. Collapsing first means "Title  :  Sub"
	// is already "Title : Sub" by the time we get here.
	out = out.replace(/ +([:;,.!?])/g, '$1')

	out = out.replaceAll('...', ELLIPSIS)

	// Dashes, most specific first.
	// A range between digits is an unspaced en dash: "2019-2020" -> "2019–2020".
	out = out.replace(/(\d)\s*-{1,2}\s*(?=\d)/g, `$1${EN_DASH}`)
	// "Title -- Subtitle" and "Title - Subtitle" both become a spaced en dash.
	// "Half-Life" has no surrounding space and is left alone, which is the point.
	out = out.replace(/\s*--\s*/g, ` ${EN_DASH} `)
	out = out.replace(/ - /g, ` ${EN_DASH} `)

	// Primes before quotes, so 5'11" reads as feet and inches rather than as an
	// apostrophe and a stray closing quote. Matched only as a complete
	// feet-and-inches pair: a looser rule turns the Swiss thousands separator in
	// "Sudoku 10'000 Plus" into a prime, which is worse than leaving 5'11" alone.
	out = out.replace(/\b(\d{1,2})'(\d{1,2})"/g, `$1${PRIME}$2${DOUBLE_PRIME}`)

	// Double quotes: an opening one follows a boundary and precedes a non-space.
	out = out.replace(/(^|[\s([{])"(?=\S)/g, `$1${LEFT_DOUBLE}`)
	out = out.replaceAll('"', RIGHT_DOUBLE)

	// Apostrophes between letters first: possessives and contractions. Doing
	// these before pair detection is what lets the pair below span them —
	// 'Contract: Skellige's Most Wanted' has three straight quotes, and only the
	// outer two are quotation.
	out = out.replace(/([A-Za-z])'([A-Za-z])/g, `$1${APOSTROPHE}$2`)

	// A matched pair around at least two characters is quotation, so it gets a
	// real opening ‘. The two-character floor is doing the work: it keeps
	// elisions like Rock 'n' Roll out, where treating the pair as quotation
	// would give ‘n’ instead of ’n’.
	out = out.replace(
		/(^|[\s([{])'([^']{2,}?)'(?=[\s)\]}.,:;!?]|$)/g,
		`$1${LEFT_SINGLE}$2${APOSTROPHE}`,
	)

	// Everything still straight becomes an apostrophe. In game titles a lone
	// leading quote is nearly always an elision ('90s, 'Splosion Man, 'Til
	// Dawn), and rendering those as ‘90s is worse than the rare unmatched
	// quotation mark coming out as ’.
	out = out.replaceAll("'", APOSTROPHE)

	return out
}
