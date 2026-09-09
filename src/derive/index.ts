import { createHash } from 'node:crypto'
import type {
	TitleExternalGame,
	TitleGenre,
	TitlePlatform,
	TitleSimilar,
	TitleWebsite,
} from '../db/schema.derived.js'
import { normalize } from '../search/normalize.js'
import { contributionOf, type FoldType } from './fold.js'
import { typeset } from './typeset.js'

/**
 * The derive step: canonical + overrides -> one title row.
 *
 * Pure. No DB handle, no network, no clock. Everything it needs arrives in
 * `DeriveInput`, which is what makes it testable against fixtures and what lets
 * the full sweep batch its loading however it likes.
 *
 * Bump DERIVE_VERSION whenever the output shape or any rule here changes. It is
 * part of `source_hash`, so bumping it invalidates every title on the next
 * sweep without needing to work out which ones were affected.
 */
export const DERIVE_VERSION = 4

export interface MemberGame {
	id: number
	name: string | null
	slug: string | null
	summary: string | null
	gameType: number | null
	versionTitle: string | null
	firstReleaseDate: Date | null
	platformIds: number[]
	genreIds: number[]
	coverImageId: string | null
	totalRatingCount: number | null
	hypes: number | null
	checksum: string | null
}

export interface DeriveMember {
	game: MemberGame
	foldType: FoldType
}

export interface DeriveInput {
	rootId: number
	/** The root first, then every folded member. */
	members: DeriveMember[]
	/** Alternative names across the root and its members. */
	alternativeNames: Array<{ gameId: number; name: string }>
	/** Native-script titles per IGDB region, across the root and its members. */
	localizations: Array<{ gameId: number; region: number; name: string }>
	developers: string[]
	publishers: string[]
	websites: TitleWebsite[]
	externalGames: TitleExternalGame[]
	similar: TitleSimilar[]
	/** From `title_patches`, if the title has one. */
	patch?: Record<string, unknown>
	/** True when IGDB has removed the root game. */
	deleted: boolean
	overridesVersion: string
}

export interface PlatformRef {
	name: string
	abbreviation: string | null
	displayName: string
	sortOrder: number
}

export interface DeriveRefs {
	platforms: Map<number, PlatformRef>
	genres: Map<number, { name: string; displayName: string }>
}

export interface DerivedTerm {
	term: string
	termNorm: string
	kind: 'root_name' | 'alt_name' | 'member_name' | 'version_title' | 'edition'
	weight: 'A' | 'B' | 'C'
}

export interface DerivedTitle {
	id: number
	slug: string
	name: string
	displayName: string
	summary: string | null
	summaryDisplay: string | null
	gameType: number
	firstReleaseDate: Date | null
	releaseYear: number | null
	coverImageId: string | null
	platforms: TitlePlatform[]
	genres: TitleGenre[]
	developers: string[]
	publishers: string[]
	editions: string[]
	expansionsNormalized: string[]
	extraCoverImageIds: string[]
	similar: TitleSimilar[]
	websites: TitleWebsite[]
	externalGames: TitleExternalGame[]
	popularity: number
	status: 'live' | 'deleted'
	sourceHash: string
	deriveVersion: number
	members: Array<{ gameId: number; foldType: FoldType }>
	terms: DerivedTerm[]
}

export function deriveTitle(input: DeriveInput, refs: DeriveRefs): DerivedTitle {
	const first = input.members[0]
	if (!first || first.foldType !== 'root') {
		throw new Error(`deriveTitle: members[0] must be the root (title ${input.rootId})`)
	}
	const root = first.game

	const platformIds = new Set<number>()
	const editions = new Set<string>()
	const expansions = new Set<string>()
	const extraCovers = new Set<string>()
	const terms = new TermSet()

	let popularity = 0
	for (const { game, foldType } of input.members) {
		// Ports contribute platforms and nothing else, which is the point of the
		// fold: "Halo (Xbox 360)" should not appear as an edition of Halo.
		for (const id of game.platformIds) platformIds.add(id)
		popularity += (game.totalRatingCount ?? 0) + (game.hypes ?? 0) * 0.5

		if (foldType === 'root') continue

		// A version child's edition name is its version_title ("Slayer Edition"),
		// not its full name ("Warhammer: Chaosbane - Slayer Edition").
		const source = foldType === 'version' ? (game.versionTitle ?? game.name) : game.name
		const raw = source?.trim()
		const bucket = contributionOf(foldType)

		if (raw) {
			if (bucket === 'editions') {
				editions.add(typeset(raw))
				terms.add(raw, foldType === 'version' ? 'version_title' : 'edition', 'C')
			} else if (bucket === 'expansions') {
				expansions.add(typeset(raw))
				terms.add(raw, 'member_name', 'C')
			} else if (bucket === 'original') {
				// The game this title was ported from, shown as its subtitle rather
				// than listed as an edition. Its old name should still find the page.
				terms.add(raw, 'member_name', 'B')
			} else {
				// A port's name still ought to find the title, even though it is
				// not displayed anywhere.
				terms.add(raw, 'member_name', 'C')
			}
		}

		if (bucket !== 'platforms-only' && game.coverImageId) extraCovers.add(game.coverImageId)
	}

	const name = root.name?.trim() ?? `Unknown game ${input.rootId}`
	terms.add(name, 'root_name', 'A')
	for (const alt of input.alternativeNames) {
		const value = alt.name?.trim()
		if (value) terms.add(value, 'alt_name', 'B')
	}
	// 夢工場ドキドキパニック should find Super Mario Bros. 2 as readily as "Doki
	// Doki Panic" does.
	for (const loc of input.localizations) {
		const value = loc.name.trim()
		if (value) terms.add(value, 'alt_name', 'B')
	}

	const patch = input.patch ?? {}
	const summary = pickString(patch.summary) ?? root.summary
	const firstReleaseDate = pickDate(patch.first_release_date) ?? root.firstReleaseDate

	return {
		id: input.rootId,
		slug: root.slug ?? String(input.rootId),
		name,
		displayName: pickString(patch.display_name) ?? typeset(name),
		summary,
		summaryDisplay: summary === null ? null : typeset(summary),
		gameType: root.gameType ?? 0,
		firstReleaseDate,
		releaseYear: firstReleaseDate ? firstReleaseDate.getUTCFullYear() : null,
		coverImageId: root.coverImageId,
		platforms: resolvePlatforms(platformIds, refs),
		genres: resolveGenres(root.genreIds, refs),
		developers: pickStrings(patch.developers) ?? input.developers,
		publishers: pickStrings(patch.publishers) ?? input.publishers,
		editions: [...editions],
		expansionsNormalized: [...expansions],
		extraCoverImageIds: [...extraCovers],
		similar: input.similar,
		websites: input.websites,
		externalGames: input.externalGames,
		popularity,
		status: input.deleted ? 'deleted' : 'live',
		sourceHash: sourceHash(input),
		deriveVersion: DERIVE_VERSION,
		members: input.members.map(({ game, foldType }) => ({ gameId: game.id, foldType })),
		terms: terms.all(),
	}
}

/**
 * Terms are keyed by (normalized text, kind) because that is the table's
 * primary key. When the same string arrives twice, keep the strongest weight —
 * a name that is both the root name and an alternative name should rank as a
 * root name.
 */
class TermSet {
	#byKey = new Map<string, DerivedTerm>()

	add(term: string, kind: DerivedTerm['kind'], weight: DerivedTerm['weight']) {
		const termNorm = normalize(term)
		if (termNorm === '') return
		const key = `${termNorm} ${kind}`
		const existing = this.#byKey.get(key)
		if (existing && existing.weight <= weight) return
		this.#byKey.set(key, { term, termNorm, kind, weight })
	}

	all(): DerivedTerm[] {
		return [...this.#byKey.values()]
	}
}

function resolvePlatforms(ids: Set<number>, refs: DeriveRefs): TitlePlatform[] {
	const out: TitlePlatform[] = []
	for (const id of ids) {
		const platform = refs.platforms.get(id)
		if (!platform) continue
		out.push({
			id,
			name: platform.name,
			displayName: platform.displayName,
			abbreviation: platform.abbreviation,
			sortOrder: platform.sortOrder,
		})
	}
	// Stable order, so an unchanged title does not produce a changed row.
	out.sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName))
	return out
}

function resolveGenres(ids: number[], refs: DeriveRefs): TitleGenre[] {
	const out: TitleGenre[] = []
	for (const id of ids) {
		const genre = refs.genres.get(id)
		if (genre) out.push({ id, name: genre.name, displayName: genre.displayName })
	}
	out.sort((a, b) => a.displayName.localeCompare(b.displayName))
	return out
}

/**
 * What the title was derived FROM.
 *
 * Every member's checksum, plus the overrides version, plus DERIVE_VERSION. If
 * this matches what is already stored, nothing about the title can have changed
 * and the worker skips the write.
 */
function sourceHash(input: DeriveInput): string {
	const parts = [
		String(DERIVE_VERSION),
		input.overridesVersion,
		input.deleted ? 'deleted' : 'live',
		...input.members
			.map(({ game, foldType }) => `${game.id}:${foldType}:${game.checksum ?? ''}`)
			.sort(),
		...input.alternativeNames.map((a) => `alt:${a.gameId}:${a.name}`).sort(),
		...input.localizations.map((l) => `loc:${l.gameId}:${l.region}:${l.name}`).sort(),
	]
	return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)
}

function pickString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function pickStrings(value: unknown): string[] | null {
	return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
}

function pickDate(value: unknown): Date | null {
	if (typeof value !== 'string') return null
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? null : date
}
