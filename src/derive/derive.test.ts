import { assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert'
import { GameType } from './fold.js'
import {
	DERIVE_VERSION,
	type DeriveInput,
	type DeriveMember,
	type DeriveRefs,
	deriveTitle,
	type MemberGame,
} from './index.js'

function game(id: number, partial: Partial<MemberGame> = {}): MemberGame {
	return {
		id,
		name: `Game ${id}`,
		slug: `game-${id}`,
		summary: null,
		gameType: GameType.MAIN_GAME,
		versionTitle: null,
		firstReleaseDate: null,
		platformIds: [],
		genreIds: [],
		coverImageId: null,
		totalRatingCount: null,
		hypes: null,
		checksum: `checksum-${id}`,
		...partial,
	}
}

function input(members: DeriveMember[], partial: Partial<DeriveInput> = {}): DeriveInput {
	const root = members[0]
	if (!root) throw new Error('need a root')
	return {
		rootId: root.game.id,
		members,
		alternativeNames: [],
		localizations: [],
		developers: [],
		publishers: [],
		websites: [],
		externalGames: [],
		similar: [],
		deleted: false,
		overridesVersion: 'test',
		...partial,
	}
}

const refs: DeriveRefs = {
	platforms: new Map([
		[6, { name: 'PC (Microsoft Windows)', abbreviation: 'PC', displayName: 'PC', sortOrder: 10 }],
		[
			48,
			{ name: 'PlayStation 4', abbreviation: 'PS4', displayName: 'PlayStation 4', sortOrder: 30 },
		],
		[
			130,
			{ name: 'Nintendo Switch', abbreviation: 'Switch', displayName: 'Switch', sortOrder: 23 },
		],
	]),
	genres: new Map([
		[12, { name: 'Role-playing (RPG)', displayName: 'RPG' }],
		[31, { name: 'Adventure', displayName: 'Adventure' }],
	]),
}

Deno.test('a bare root derives', () => {
	const title = deriveTitle(
		input([{ game: game(1, { name: "Baldur's Gate" }), foldType: 'root' }]),
		refs,
	)
	assertEquals(title.id, 1)
	assertEquals(title.name, "Baldur's Gate")
	assertEquals(title.displayName, 'Baldur’s Gate')
	assertEquals(title.status, 'live')
	assertEquals(title.deriveVersion, DERIVE_VERSION)
	assertEquals(title.members, [{ gameId: 1, foldType: 'root' }])
})

Deno.test('members[0] must be the root', () => {
	assertThrows(
		() => deriveTitle(input([{ game: game(1), foldType: 'dlc' }]), refs),
		Error,
		'members[0] must be the root',
	)
})

Deno.test('ports merge platforms and contribute no name', () => {
	const title = deriveTitle(
		input([
			{ game: game(1, { platformIds: [6] }), foldType: 'root' },
			{ game: game(2, { name: 'Game 1 (Switch)', platformIds: [130] }), foldType: 'port' },
		]),
		refs,
	)
	assertEquals(
		title.platforms.map((p) => p.id),
		[6, 130],
	)
	assertEquals(title.editions, [])
	assertEquals(title.expansionsNormalized, [])
})

Deno.test('a port name is still searchable even though it is never displayed', () => {
	const title = deriveTitle(
		input([
			{ game: game(1), foldType: 'root' },
			{ game: game(2, { name: 'Game 1 HD' }), foldType: 'port' },
		]),
		refs,
	)
	assertEquals(
		title.terms.some((t) => t.term === 'Game 1 HD' && t.kind === 'member_name'),
		true,
	)
})

Deno.test('DLC and expansions go to expansions_normalized', () => {
	const title = deriveTitle(
		input([
			{ game: game(1), foldType: 'root' },
			{ game: game(2, { name: 'Hearts of Stone', coverImageId: 'co2' }), foldType: 'dlc' },
			{ game: game(3, { name: 'Blood and Wine', coverImageId: 'co3' }), foldType: 'expansion' },
		]),
		refs,
	)
	assertEquals(title.expansionsNormalized, ['Hearts of Stone', 'Blood and Wine'])
	assertEquals(title.editions, [])
	assertEquals(title.extraCoverImageIds, ['co2', 'co3'])
})

Deno.test('remasters go to editions', () => {
	const title = deriveTitle(
		input([
			{ game: game(1), foldType: 'root' },
			{ game: game(2, { name: 'Game 1 Remastered' }), foldType: 'remaster' },
		]),
		refs,
	)
	assertEquals(title.editions, ['Game 1 Remastered'])
})

Deno.test('a version child contributes its version_title, not its full name', () => {
	const title = deriveTitle(
		input([
			{ game: game(1, { name: 'Warhammer: Chaosbane' }), foldType: 'root' },
			{
				game: game(2, {
					name: 'Warhammer: Chaosbane - Slayer Edition',
					versionTitle: 'Slayer Edition',
				}),
				foldType: 'version',
			},
		]),
		refs,
	)
	assertEquals(title.editions, ['Slayer Edition'])
	assertEquals(
		title.terms.some((t) => t.term === 'Slayer Edition' && t.kind === 'version_title'),
		true,
	)
})

Deno.test('a version child with no version_title falls back to its name', () => {
	const title = deriveTitle(
		input([
			{ game: game(1), foldType: 'root' },
			{ game: game(2, { name: 'Game 1: Special', versionTitle: null }), foldType: 'version' },
		]),
		refs,
	)
	assertEquals(title.editions, ['Game 1: Special'])
})

Deno.test('display strings are typeset, terms are not', () => {
	const title = deriveTitle(
		input([
			{ game: game(1, { name: "Don't Starve" }), foldType: 'root' },
			{ game: game(2, { name: "Reign of Giants - Collector's" }), foldType: 'expansion' },
		]),
		refs,
	)
	assertEquals(title.displayName, 'Don’t Starve')
	assertEquals(title.name, "Don't Starve")
	assertEquals(title.expansionsNormalized, ['Reign of Giants – Collector’s'])
	// The searchable term keeps IGDB's own text.
	assertEquals(
		title.terms.some((t) => t.term === "Reign of Giants - Collector's"),
		true,
	)
})

Deno.test('summary_display is typeset and summary is not', () => {
	const title = deriveTitle(
		input([{ game: game(1, { summary: "It's a game -- a good one..." }), foldType: 'root' }]),
		refs,
	)
	assertEquals(title.summary, "It's a game -- a good one...")
	assertEquals(title.summaryDisplay, 'It’s a game – a good one…')
})

Deno.test('a null summary stays null on both columns', () => {
	const title = deriveTitle(input([{ game: game(1, { summary: null }), foldType: 'root' }]), refs)
	assertEquals(title.summary, null)
	assertEquals(title.summaryDisplay, null)
})

Deno.test('platforms sort by override order, genres by display name', () => {
	const title = deriveTitle(
		input([{ game: game(1, { platformIds: [48, 6, 130], genreIds: [12, 31] }), foldType: 'root' }]),
		refs,
	)
	assertEquals(
		title.platforms.map((p) => p.displayName),
		['PC', 'Switch', 'PlayStation 4'],
	)
	assertEquals(
		title.genres.map((g) => g.displayName),
		['Adventure', 'RPG'],
	)
})

Deno.test('a platform we do not have a row for is dropped, not faked', () => {
	const title = deriveTitle(
		input([{ game: game(1, { platformIds: [6, 99999] }), foldType: 'root' }]),
		refs,
	)
	assertEquals(
		title.platforms.map((p) => p.id),
		[6],
	)
})

Deno.test('release_year comes from first_release_date in UTC', () => {
	const title = deriveTitle(
		input([
			{ game: game(1, { firstReleaseDate: new Date('2015-05-19T00:00:00Z') }), foldType: 'root' },
		]),
		refs,
	)
	assertEquals(title.releaseYear, 2015)
})

Deno.test('popularity sums across the root and every member', () => {
	const title = deriveTitle(
		input([
			{ game: game(1, { totalRatingCount: 100, hypes: 10 }), foldType: 'root' },
			{ game: game(2, { totalRatingCount: 40, hypes: null }), foldType: 'dlc' },
		]),
		refs,
	)
	assertEquals(title.popularity, 100 + 5 + 40)
})

Deno.test('terms carry the right weight per kind', () => {
	const title = deriveTitle(
		input(
			[
				{ game: game(1, { name: 'Breath of the Wild' }), foldType: 'root' },
				{ game: game(2, { name: 'The Master Trials' }), foldType: 'dlc' },
			],
			{ alternativeNames: [{ gameId: 1, name: 'BotW' }] },
		),
		refs,
	)
	const byTerm = new Map(title.terms.map((t) => [t.term, t]))
	assertEquals(byTerm.get('Breath of the Wild')?.weight, 'A')
	assertEquals(byTerm.get('BotW')?.weight, 'B')
	assertEquals(byTerm.get('The Master Trials')?.weight, 'C')
	assertEquals(byTerm.get('BotW')?.termNorm, 'botw')
})

Deno.test('a deleted root still derives, as a tombstone', () => {
	const title = deriveTitle(input([{ game: game(1), foldType: 'root' }], { deleted: true }), refs)
	// The page still renders from the last known data; §7.3.
	assertEquals(title.status, 'deleted')
	assertEquals(title.name, 'Game 1')
})

Deno.test('a patch overrides the derived value', () => {
	const title = deriveTitle(
		input([{ game: game(1, { name: 'Wrong Name' }), foldType: 'root' }], {
			patch: {
				display_name: 'Right Name',
				developers: ['Studio'],
				first_release_date: '2001-02-03T00:00:00Z',
			},
		}),
		refs,
	)
	assertEquals(title.displayName, 'Right Name')
	assertEquals(title.developers, ['Studio'])
	assertEquals(title.releaseYear, 2001)
	// The raw name is untouched, so search still finds what IGDB shipped.
	assertEquals(title.name, 'Wrong Name')
})

Deno.test('a malformed patch is ignored rather than trusted', () => {
	const title = deriveTitle(
		input([{ game: game(1, { name: 'Real Name' }), foldType: 'root' }], {
			patch: { display_name: 42, developers: 'Studio', first_release_date: 'not a date' },
		}),
		refs,
	)
	assertEquals(title.displayName, 'Real Name')
	assertEquals(title.developers, [])
	assertEquals(title.releaseYear, null)
})

Deno.test('source_hash is stable across runs and changes with the inputs', () => {
	const members: DeriveMember[] = [
		{ game: game(1), foldType: 'root' },
		{ game: game(2), foldType: 'dlc' },
	]
	const a = deriveTitle(input(members), refs)
	const b = deriveTitle(input(members), refs)
	assertEquals(a.sourceHash, b.sourceHash)

	// A member's checksum moving means the title has to be rebuilt.
	const changed = deriveTitle(
		input([
			{ game: game(1), foldType: 'root' },
			{ game: game(2, { checksum: 'new' }), foldType: 'dlc' },
		]),
		refs,
	)
	assertNotEquals(a.sourceHash, changed.sourceHash)

	// So does an override edit, which is how one file change invalidates the lot.
	const reOverridden = deriveTitle(input(members, { overridesVersion: 'other' }), refs)
	assertNotEquals(a.sourceHash, reOverridden.sourceHash)
})

Deno.test('member order does not change source_hash', () => {
	const a = deriveTitle(
		input([
			{ game: game(1), foldType: 'root' },
			{ game: game(2), foldType: 'dlc' },
			{ game: game(3), foldType: 'dlc' },
		]),
		refs,
	)
	const b = deriveTitle(
		input([
			{ game: game(1), foldType: 'root' },
			{ game: game(3), foldType: 'dlc' },
			{ game: game(2), foldType: 'dlc' },
		]),
		refs,
	)
	assertEquals(a.sourceHash, b.sourceHash)
})

Deno.test('a root with no name still produces a usable title', () => {
	const title = deriveTitle(
		input([{ game: game(7, { name: null, slug: null }), foldType: 'root' }]),
		refs,
	)
	assertEquals(title.name, 'Unknown game 7')
	assertEquals(title.slug, '7')
})
