/**
 * IGDB related-title fold layer (pure).
 *
 * This module collapses IGDB's many related game entities (ports, dlcs,
 * expansions, remasters, versions, ...) into a single primary title. It has NO
 * dependency on the DB or config — every IGDB call goes through an injected
 * `IgdbRequestFn`, which keeps the logic unit-testable with mock data (no live
 * API, no Postgres). `data.ts` wires in the real `igdbRequest`.
 */

interface IgdbPlatform {
	id?: number
	name?: string
}

interface IgdbCover {
	url?: string
}

export interface IgdbGame {
	id: number
	name?: string
	slug?: string
	checksum?: string
	category?: number
	parent_game?: number
	version_parent?: number
	version_title?: string
	cover?: IgdbCover
	platforms?: IgdbPlatform[]
	// Relation arrays hold child game ids.
	dlcs?: number[]
	expansions?: number[]
	standalone_expansions?: number[]
	expanded_games?: number[]
	forks?: number[]
	ports?: number[]
	remakes?: number[]
	remasters?: number[]
	bundles?: number[]
	// Enriched fold output (written by foldRelations, surfaced in payload).
	expansions_normalized?: string[]
	editions?: string[]
	extra_covers?: string[]
	[key: string]: unknown
}

/**
 * The subset of `igdbRequest` the fold layer needs. Injectable so tests can
 * drive `foldRelations` / `resolveRootGame` with mock data (no live API).
 */
export type IgdbRequestFn = <T = unknown>(endpoint: string, body: string) => Promise<T>

// The fields we want IGDB to return for a game. Tweak as the front-end needs.
// Includes the relation/category fields the fold layer needs to collapse
// related titles (ports, dlcs, expansions, remasters, versions) into the base.
export const GAME_FIELDS =
	'name,slug,url,summary,first_release_date,rating,cover.url,genres.name,platforms.id,platforms.name,involved_companies.company.name,involved_companies.publisher,involved_companies.developer,websites.url,websites.type.type,similar_games.id,similar_games.name,similar_games.cover.url,similar_games.platforms.name,checksum,category,parent_game,version_parent,version_title,dlcs,expansions,standalone_expansions,expanded_games,forks,ports,remakes,remasters,bundles'

// Lighter field set for related games we only fetch to fold into a base title.
const RELATED_FIELDS =
	'name,cover.url,platforms.id,platforms.name,category,version_parent,version_title,dlcs,expansions,standalone_expansions,expanded_games,forks,ports,remakes,remasters,bundles,parent_game'

/**
 * IGDB `category` enum (legacy int). We use it to classify a game on direct
 * lookup and to filter search results.
 */
export const Category = {
	MAIN_GAME: 0,
	DLC_ADDON: 1,
	EXPANSION: 2,
	BUNDLE: 3,
	STANDALONE_EXPANSION: 4,
	MOD: 5,
	EPISODE: 6,
	SEASON: 7,
	REMAKE: 8,
	REMASTER: 9,
	EXPANDED_GAME: 10,
	PORT: 11,
	FORK: 12,
	PACK: 13,
	UPDATE: 14,
} as const

// Categories that get their own rows and surface in search/nav (primary titles
// plus the "keep as separate" relations).
export const SEPARATE_CATEGORIES = new Set<number>([
	Category.MAIN_GAME,
	Category.STANDALONE_EXPANSION,
	Category.REMAKE,
	Category.EXPANDED_GAME,
	Category.FORK,
])

// Categories we never ingest at all.
const NEVER_CATEGORIES = new Set<number>([
	Category.BUNDLE,
	Category.MOD,
	Category.EPISODE,
	Category.SEASON,
	Category.PACK,
	Category.UPDATE,
])

// How each relation array on a base game folds into it.
type FoldType = 'platforms' | 'expansion' | 'remaster'

// Relation arrays we walk + recurse into when folding, with their fold behavior.
const FOLD_RELATIONS: ReadonlyArray<{ key: keyof IgdbGame; fold: FoldType }> = [
	{ key: 'ports', fold: 'platforms' },
	{ key: 'dlcs', fold: 'expansion' },
	{ key: 'expansions', fold: 'expansion' },
	{ key: 'remasters', fold: 'remaster' },
]

/** Batch-fetch related games by id (one IGDB call) for the fold walk. */
async function fetchGamesByIds(ids: number[], request: IgdbRequestFn): Promise<IgdbGame[]> {
	if (ids.length === 0) return []
	return request<IgdbGame[]>(
		'games',
		`fields ${RELATED_FIELDS}; where id = (${ids.join(',')}); limit 500;`,
	)
}

/**
 * Walk a directly-requested game up to its primary title.
 *
 * IGDB returns DLCs, ports, versions, etc. as their own game records. We never
 * expose those — if one is requested directly we resolve up through
 * `parent_game` / `version_parent` until we hit a "separate" (own-row) title.
 * Guards against cycles and missing parents (falls back to the game we have).
 */
export async function resolveRootGame(game: IgdbGame, request: IgdbRequestFn): Promise<IgdbGame> {
	const seen = new Set<number>([game.id])
	let current = game

	// Loop while the current game is a foldable/never type and points upward.
	while (current.category !== undefined && !SEPARATE_CATEGORIES.has(current.category)) {
		const parentId = current.version_parent ?? current.parent_game
		if (typeof parentId !== 'number' || seen.has(parentId)) break
		seen.add(parentId)

		const rows = await request<IgdbGame[]>(
			'games',
			`fields ${GAME_FIELDS}; where id = ${parentId};`,
		)
		const parent = rows[0]
		if (!parent) break
		current = parent
	}

	return current
}

/**
 * Collapse related titles into `root`, returning an enriched copy.
 *
 * Folds (recursively, via the relation arrays):
 *   - ports        -> merge platforms only
 *   - dlcs/expns   -> merge platforms; name -> expansions_normalized; cover -> extra_covers
 *   - remasters    -> merge platforms; name -> editions; cover -> extra_covers
 * Plus version children (games whose version_parent === root.id): version_title -> editions.
 *
 * Recursion handles chains like "a remaster of an expansion of a base game":
 * each folded child's own fold-relations are enqueued. A `visited` set keyed by
 * game id breaks cycles.
 */
export async function foldRelations(root: IgdbGame, request: IgdbRequestFn): Promise<IgdbGame> {
	const platforms = new Map<number | string, IgdbPlatform>()
	for (const p of root.platforms ?? []) platforms.set(p.id ?? p.name ?? '', p)

	const expansionsNormalized = new Set<string>()
	const editions = new Set<string>()
	const extraCovers = new Set<string>()

	const mergePlatforms = (list?: IgdbPlatform[]) => {
		for (const p of list ?? []) platforms.set(p.id ?? p.name ?? '', p)
	}

	const visited = new Set<number>([root.id])
	let frontier: Array<{ id: number; fold: FoldType }> = []
	const enqueue = (g: IgdbGame) => {
		for (const { key, fold } of FOLD_RELATIONS) {
			for (const childId of (g[key] as number[] | undefined) ?? []) {
				if (!visited.has(childId)) frontier.push({ id: childId, fold })
			}
		}
	}
	enqueue(root)

	// BFS layer by layer, batching the id fetch per layer.
	while (frontier.length > 0) {
		const layer = frontier
		frontier = []

		// Dedupe ids in this layer; keep the first fold type seen for each.
		const foldById = new Map<number, FoldType>()
		for (const { id, fold } of layer) {
			if (visited.has(id)) continue
			if (!foldById.has(id)) foldById.set(id, fold)
		}
		const ids = [...foldById.keys()]
		if (ids.length === 0) continue
		for (const id of ids) visited.add(id)

		const children = await fetchGamesByIds(ids, request)
		for (const child of children) {
			// Skip anything we never ingest, even if reached via a relation array.
			if (child.category !== undefined && NEVER_CATEGORIES.has(child.category)) continue

			const fold = foldById.get(child.id)
			mergePlatforms(child.platforms)
			const name = child.name?.trim()
			const coverUrl = child.cover?.url
			if (fold === 'expansion' && name) expansionsNormalized.add(name)
			if (fold === 'remaster' && name) editions.add(name)
			if ((fold === 'expansion' || fold === 'remaster') && coverUrl) extraCovers.add(coverUrl)

			// Recurse into this child's own foldable relations.
			enqueue(child)
		}
	}

	// Version children: not reachable via a relation array on the base — query them.
	const versionChildren = await request<IgdbGame[]>(
		'games',
		`fields version_title; where version_parent = ${root.id}; limit 500;`,
	)
	for (const v of versionChildren) {
		const title = v.version_title?.trim()
		if (title) editions.add(title)
	}

	return {
		...root,
		platforms: [...platforms.values()],
		expansions_normalized: [...expansionsNormalized],
		editions: [...editions],
		extra_covers: [...extraCovers],
	}
}
