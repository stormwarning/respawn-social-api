/**
 * Query and term normalization for search.
 *
 * The exact same function runs over `title_terms.term_norm` at derive time and
 * over the user's query at request time. That symmetry is the whole contract:
 * if the two ever diverge, "Pokemon" stops finding "Pokémon" and nothing in the
 * type system notices. See §8.1 of docs/PLAN-igdb-mirror.md.
 *
 * Deliberately NOT the inverse of typeset(). This undoes smart punctuation
 * rather than applying it, so a user typing a straight apostrophe matches a
 * title that carries a curly one.
 */
export function normalize(text: string): string {
	return (
		text
			// Decompose, then drop combining marks: é -> e, ō -> o.
			.normalize('NFKD')
			.replace(/\p{M}+/gu, '')
			.toLowerCase()
			// Fold every quote and dash variant onto its ASCII form, so the shape of
			// the punctuation never decides whether a query matches.
			.replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
			.replace(/[\u201C\u201D\u2033]/g, '"')
			.replace(/[\u2010-\u2015\u2212]/g, '-')
			// A run of hyphens is one dash. Without this, typeset("A -- B") and the raw
			// "A -- B" normalize differently and the title becomes unfindable by the
			// text IGDB actually shipped.
			.replace(/-{2,}/g, '-')
			.replace(/\u2026/g, '...')
			// U+FEFF and friends survive NFKD; some IGDB names start with a BOM.
			.replace(/[\u200B-\u200D\uFEFF]/g, '')
			.replace(/\s+/g, ' ')
			.trim()
	)
}
