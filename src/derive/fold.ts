/**
 * Root resolution and fold classification — pure, no DB, no network.
 *
 * IGDB models a franchise as many separate game records: the base game, its
 * DLC, its ports, its "Collector's Edition", its remasters. We collapse all of
 * that into ONE title, and this module decides which record is the title and
 * what every other record contributes to it. See §6.2/§6.3 of
 * docs/PLAN-igdb-mirror.md.
 *
 * The load-bearing invariant: `title_members.game_id` is a primary key, so
 * every game belongs to exactly one title. `resolveRoot` is the single
 * definition of which one — membership is never decided anywhere else.
 */

/** IGDB's `game_type` enum (formerly `category`, same values). */
export const GameType = {
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

/** Types that get their own title row. */
export const OWN_TITLE_TYPES: ReadonlySet<number> = new Set([
	GameType.MAIN_GAME,
	GameType.STANDALONE_EXPANSION,
	GameType.REMAKE,
	GameType.EXPANDED_GAME,
	GameType.FORK,
])

/** Types we never ingest at all, even when a title points straight at them. */
export const NEVER_TYPES: ReadonlySet<number> = new Set([
	GameType.BUNDLE,
	GameType.MOD,
	GameType.EPISODE,
	GameType.SEASON,
	GameType.PACK,
	GameType.UPDATE,
])

export type FoldType =
	| 'root'
	| 'original'
	| 'port'
	| 'dlc'
	| 'expansion'
	| 'remaster'
	| 'version'
	| 'override'

export interface GameNode {
	id: number
	gameType: number | null
	parentGame: number | null
	versionParent: number | null
	deleted: boolean
}

export interface FoldOverride {
	action: 'fold_into' | 'keep_separate' | 'hide'
	targetGameId: number | null
}

export interface FoldContext {
	game(id: number): GameNode | undefined
	override(id: number): FoldOverride | undefined
}

/**
 * Which title does this game belong to?
 *
 * Returns the root game's id, or null when the game is one we never ingest.
 *
 * Order matters, and it is not the order the plan originally specified. The
 * `version_parent` check has to come BEFORE the game-type check: 6,888 version
 * children in the catalogue carry `game_type = 0` while being plainly editions
 * ("Warhammer: Chaosbane - Slayer Edition", "Coridden: Deluxe Edition"). Testing
 * the type first would give every one of them its own title row.
 */
export function resolveRoot(gameId: number, ctx: FoldContext): number | null {
	const seen = new Set<number>()
	let current = gameId

	for (;;) {
		// A cycle in IGDB's parent pointers: stop where we are rather than loop.
		if (seen.has(current)) return current
		seen.add(current)

		const override = ctx.override(current)
		if (override) {
			if (override.action === 'hide') return null
			if (override.action === 'keep_separate') return current
			if (override.action === 'fold_into' && override.targetGameId !== null) {
				current = override.targetGameId
				continue
			}
		}

		const game = ctx.game(current)
		// Not mirrored: nothing to resolve against.
		if (!game) return current === gameId ? null : current

		const parentId = game.versionParent ?? game.parentGame
		const parent = parentId === null ? undefined : ctx.game(parentId)
		// An orphan child — parent missing or tombstoned — becomes its own title
		// rather than vanishing, because user records may already point at it.
		const hasUsableParent = parentId !== null && parent !== undefined && !parent.deleted

		// A version child folds into its parent WHATEVER its own type says, and
		// this is checked before NEVER_TYPES on purpose. IGDB files a lot of
		// special editions as bundles — "Hollow Knight: Collector's Edition" is
		// game_type 3 with version_parent 14593 — and `version_parent` is an
		// explicit statement that this is a version of that title, which is far
		// better evidence than the type. Testing the type first silently drops
		// 923 real editions. A version child that should NOT fold is what
		// `fold_overrides.keep_separate` is for.
		if (hasUsableParent && game.versionParent !== null) {
			current = parentId
			continue
		}

		if (game.gameType !== null && NEVER_TYPES.has(game.gameType)) return null
		if (!hasUsableParent) return current
		if (game.gameType === null || OWN_TITLE_TYPES.has(game.gameType)) return current

		current = parentId
	}
}

/**
 * What a folded member contributes to its title.
 *
 * Taken from the member's own `game_type` rather than from which relation array
 * on the root happened to list it. The two agree: of 28,900 relation-array
 * edges in the catalogue, exactly 2 disagree with the child's parent pointer,
 * and every one of the 28,898 parented children is listed by its parent. Using
 * the child's type keeps this consistent with `resolveRoot` by construction,
 * and reads straight off an indexed column instead of nine GIN lookups.
 */
export function foldTypeOf(game: GameNode, root: GameNode, overridden: boolean): FoldType {
	if (game.id === root.id) return 'root'
	// The game the root was itself derived from, now folded underneath it. Only
	// an override can arrange this — a root with a live parent would have
	// climbed — and it is how a crowned port carries its original: Super Mario
	// Bros. 2 is IGDB's port of Doki-doki Panic, and the page is SMB2's.
	if (game.id === root.parentGame || game.id === root.versionParent) return 'original'
	if (overridden) return 'override'
	if (game.versionParent !== null) return 'version'

	switch (game.gameType) {
		case GameType.PORT:
			return 'port'
		case GameType.DLC_ADDON:
			return 'dlc'
		case GameType.EXPANSION:
			return 'expansion'
		case GameType.REMASTER:
			return 'remaster'
		default:
			// Reached only when a member folded for a reason its type does not
			// explain — treat it like an edition rather than dropping it.
			return 'override'
	}
}

/** Where a member's name goes on the derived title. */
export function contributionOf(
	foldType: FoldType,
): 'editions' | 'expansions' | 'original' | 'platforms-only' {
	switch (foldType) {
		case 'original':
			// Shown as the title's subtitle, not as an edition of itself.
			return 'original'
		case 'dlc':
		case 'expansion':
			return 'expansions'
		case 'remaster':
		case 'version':
		case 'override':
			return 'editions'
		default:
			// Ports merge platforms and contribute no name: "Halo (Xbox 360)" is
			// not a thing anyone wants to see listed under Halo.
			return 'platforms-only'
	}
}
