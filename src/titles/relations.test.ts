import { assertEquals } from 'jsr:@std/assert'
import postgres from 'postgres'
import { config } from '../config.js'
import { loadRelations, relationLabel, stripTitlePrefix } from './relations.js'
import { GameType } from '../derive/fold.js'

/**
 * The fold hides things, and a page has to show what it hid or the fold looks
 * like data loss. These pin both directions: what was absorbed into a title,
 * and what descends from it but kept its own page.
 */

const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

const BASE = 999_500_001
const DLC = 999_500_002
const EDITION = 999_500_003
const REMAKE = 999_500_004
const PORT = 999_500_005
const IDS = [BASE, DLC, EDITION, REMAKE, PORT]

async function cleanup() {
	await sql`delete from title_terms where title_id = any(${IDS})`
	await sql`delete from title_members where game_id = any(${IDS}) or title_id = any(${IDS})`
	await sql`delete from titles where id = any(${IDS})`
	await sql`delete from igdb_games where id = any(${IDS})`
}

async function insertTitle(id: number, slug: string, name: string, releaseYear: number) {
	await sql`
		insert into titles (
			id, slug, name, display_name, game_type, release_year, platforms, genres,
			developers, publishers, editions, expansions_normalized, extra_cover_image_ids,
			-- "similar" quoted: SIMILAR is a reserved keyword (SIMILAR TO).
			"similar", websites, external_games, status, source_hash, derive_version
		) values (
			${id}, ${slug}, ${name}, ${name}, 0, ${releaseYear},
			'[]', '[]', '{}', '{}', '{}', '{}', '{}', '[]', '[]', '[]', 'live', 'h', 1
		)
	`
}

/**
 * A base game with a DLC, an edition and a port folded in, plus a remake that
 * kept its own page. The shape of a real franchise in miniature.
 */
async function seed() {
	await cleanup()

	await sql`
		insert into igdb_games (id, name, slug, game_type, first_release_date, checksum) values
			(${BASE},    'Relations Test Game', 'relations-test-game', ${GameType.MAIN_GAME}, '2015-01-01', gen_random_uuid()),
			(${DLC},     'Relations Test Game - The Extra Bit', 'rtg-extra', ${GameType.DLC_ADDON}, '2016-01-01', gen_random_uuid()),
			(${EDITION}, 'Relations Test Game: Deluxe', 'rtg-deluxe', ${GameType.MAIN_GAME}, '2016-06-01', gen_random_uuid()),
			(${REMAKE},  'Relations Test Game Remade', 'rtg-remade', ${GameType.REMAKE}, '2022-01-01', gen_random_uuid()),
			(${PORT},    'Relations Test Game (Switch)', 'rtg-switch', ${GameType.PORT}, '2019-01-01', gen_random_uuid())
	`
	await sql`update igdb_games set parent_game = ${BASE} where id in (${DLC}, ${REMAKE}, ${PORT})`
	await sql`
		update igdb_games set version_parent = ${BASE}, version_title = 'Deluxe Edition'
		where id = ${EDITION}
	`

	await insertTitle(BASE, 'relations-test-game', 'Relations Test Game', 2015)
	await insertTitle(REMAKE, 'rtg-remade', 'Relations Test Game Remade', 2022)

	await sql`
		insert into title_members (game_id, title_id, fold_type) values
			(${BASE}, ${BASE}, 'root'),
			(${DLC}, ${BASE}, 'dlc'),
			(${EDITION}, ${BASE}, 'version'),
			(${PORT}, ${BASE}, 'port'),
			(${REMAKE}, ${REMAKE}, 'root')
	`
}

Deno.test('relationLabel translates IGDB types into words a reader wants', () => {
	assertEquals(relationLabel(GameType.REMAKE), 'Remake')
	assertEquals(relationLabel(GameType.FORK), 'Fork')
	// IGDB's internal names are not shown: expanded_game, standalone_expansion.
	assertEquals(relationLabel(GameType.EXPANDED_GAME), 'Expanded edition')
	assertEquals(relationLabel(GameType.STANDALONE_EXPANSION), 'Expansion')
	// A base game is not a version of anything.
	assertEquals(relationLabel(GameType.MAIN_GAME), null)
	assertEquals(relationLabel(null), null)
})

Deno.test('stripTitlePrefix removes the parent name and its separator', () => {
	assertEquals(
		stripTitlePrefix('The Witcher 3: Wild Hunt - Blood and Wine', 'The Witcher 3: Wild Hunt'),
		'Blood and Wine',
	)
	assertEquals(stripTitlePrefix('Halo: Reach', 'Halo'), 'Reach')
	assertEquals(
		stripTitlePrefix('Portal 2 Sixense Perceptual Pack', 'Portal 2'),
		'Sixense Perceptual Pack',
	)
})

Deno.test('stripTitlePrefix leaves a name that shares no prefix alone', () => {
	assertEquals(stripTitlePrefix('Blood and Wine', 'The Witcher 3'), 'Blood and Wine')
	assertEquals(stripTitlePrefix('Anything', null), 'Anything')
})

Deno.test('stripTitlePrefix keeps the full name rather than returning nothing', () => {
	// A member whose entire name IS the title's would otherwise render blank.
	assertEquals(stripTitlePrefix('Grand Theft Auto V', 'Grand Theft Auto V'), 'Grand Theft Auto V')
})

Deno.test('a base game lists what was folded into it', async () => {
	await seed()
	const relations = await loadRelations(BASE)

	assertEquals(relations.parent, null)
	assertEquals(relations.relationToParent, null)

	const byType = Object.fromEntries(relations.folded.map((m) => [m.foldType, m]))

	// The DLC keeps its full name but sheds the redundant title prefix.
	assertEquals(byType.dlc?.displayName, 'Relations Test Game – The Extra Bit')
	assertEquals(byType.dlc?.shortName, 'The Extra Bit')
	assertEquals(byType.dlc?.label, 'DLC')

	// An edition shows its version title, not its full name.
	assertEquals(byType.version?.displayName, 'Deluxe Edition')
	assertEquals(byType.version?.label, 'Edition')

	// Ports are in the payload; whether to render them is the client's call.
	assertEquals(byType.port?.label, 'Port')

	// The root is a member but never listed as folded into itself.
	assertEquals(
		relations.folded.some((m) => m.id === BASE),
		false,
	)
	assertEquals(
		relations.memberIds,
		[BASE, DLC, EDITION, PORT].sort((a, b) => a - b),
	)

	await cleanup()
})

Deno.test('a base game links to descendants that kept their own page', async () => {
	await seed()
	const relations = await loadRelations(BASE)

	assertEquals(relations.related.length, 1)
	assertEquals(relations.related[0]?.id, REMAKE)
	assertEquals(relations.related[0]?.relation, 'Remake')
	assertEquals(relations.related[0]?.slug, 'rtg-remade')
	assertEquals(relations.related[0]?.releaseYear, 2022)

	// Folded members are never also "released separately" — that would show the
	// same thing twice under contradictory headings.
	assertEquals(
		relations.related.some((r) => r.id === DLC),
		false,
	)

	await cleanup()
})

Deno.test('a child title says what it is and links back', async () => {
	await seed()
	const relations = await loadRelations(REMAKE)

	assertEquals(relations.relationToParent, 'Remake')
	assertEquals(relations.parent?.id, BASE)
	assertEquals(relations.parent?.slug, 'relations-test-game')
	// The relationship is described once, on `relationToParent`. Putting it on
	// the parent ref too would read as though the PARENT were the remake.
	assertEquals(relations.parent?.relation, null)

	await cleanup()
})

Deno.test('a title with no relations returns empty, not null', async () => {
	await seed()
	// Everything hangs off BASE, so the remake has no descendants of its own.
	const relations = await loadRelations(REMAKE)
	assertEquals(relations.folded, [])
	assertEquals(relations.related, [])
	await cleanup()
})

Deno.test('a tombstoned descendant is not offered as a link', async () => {
	await seed()
	await sql`update titles set status = 'deleted' where id = ${REMAKE}`
	const relations = await loadRelations(BASE)
	assertEquals(relations.related, [])
	await cleanup()
})

Deno.test('close the connection', async () => {
	await cleanup()
	await sql.end()
})
