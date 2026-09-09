import { assertEquals } from 'jsr:@std/assert'
import {
	contributionOf,
	type FoldContext,
	type FoldOverride,
	foldTypeOf,
	type GameNode,
	GameType,
	resolveRoot,
} from './fold.js'

function node(id: number, partial: Partial<GameNode> = {}): GameNode {
	return {
		id,
		gameType: GameType.MAIN_GAME,
		parentGame: null,
		versionParent: null,
		deleted: false,
		...partial,
	}
}

function context(games: GameNode[], overrides: Record<number, FoldOverride> = {}): FoldContext {
	const byId = new Map(games.map((g) => [g.id, g]))
	return {
		game: (id) => byId.get(id),
		override: (id) => overrides[id],
	}
}

Deno.test('a main game is its own root', () => {
	const ctx = context([node(1)])
	assertEquals(resolveRoot(1, ctx), 1)
})

Deno.test('a DLC resolves to its parent', () => {
	const ctx = context([node(1), node(2, { gameType: GameType.DLC_ADDON, parentGame: 1 })])
	assertEquals(resolveRoot(2, ctx), 1)
})

Deno.test('a port resolves to its parent', () => {
	const ctx = context([node(1), node(2, { gameType: GameType.PORT, parentGame: 1 })])
	assertEquals(resolveRoot(2, ctx), 1)
})

Deno.test('a chain of folds climbs all the way to the base game', () => {
	// A remaster of an expansion of a base game.
	const ctx = context([
		node(1),
		node(2, { gameType: GameType.EXPANSION, parentGame: 1 }),
		node(3, { gameType: GameType.REMASTER, parentGame: 2 }),
	])
	assertEquals(resolveRoot(3, ctx), 1)
})

Deno.test('a standalone expansion keeps its own title', () => {
	const ctx = context([
		node(1),
		node(2, { gameType: GameType.STANDALONE_EXPANSION, parentGame: 1 }),
	])
	assertEquals(resolveRoot(2, ctx), 2)
})

Deno.test('a remake keeps its own title', () => {
	const ctx = context([node(1), node(2, { gameType: GameType.REMAKE, parentGame: 1 })])
	assertEquals(resolveRoot(2, ctx), 2)
})

Deno.test('a version child folds even when its type is main_game', () => {
	// The 6,888-row case: "Warhammer: Chaosbane - Slayer Edition" is game_type 0
	// with version_parent set. Testing the type first would give it its own title.
	const ctx = context([node(1), node(2, { gameType: GameType.MAIN_GAME, versionParent: 1 })])
	assertEquals(resolveRoot(2, ctx), 1)
})

Deno.test('version_parent wins over parent_game when they disagree', () => {
	const ctx = context([
		node(1),
		node(2),
		node(3, { gameType: GameType.DLC_ADDON, parentGame: 1, versionParent: 2 }),
	])
	assertEquals(resolveRoot(3, ctx), 2)
})

Deno.test('a never-ingested type resolves to nothing', () => {
	for (const gameType of [GameType.BUNDLE, GameType.MOD, GameType.PACK, GameType.UPDATE]) {
		const ctx = context([node(1), node(2, { gameType, parentGame: 1 })])
		assertEquals(resolveRoot(2, ctx), null, `game_type ${gameType} should not resolve`)
	}
})

Deno.test('a never-ingested type still folds when it is a version child', () => {
	// "Hollow Knight: Collector's Edition" is game_type 3 (bundle) with
	// version_parent set. IGDB files a lot of special editions this way, and
	// `version_parent` is better evidence than the type.
	const ctx = context([node(1), node(2, { gameType: GameType.BUNDLE, versionParent: 1 })])
	assertEquals(resolveRoot(2, ctx), 1)
})

Deno.test("a bundle that is nobody's version child still resolves to nothing", () => {
	const ctx = context([node(1), node(2, { gameType: GameType.BUNDLE, parentGame: 1 })])
	assertEquals(resolveRoot(2, ctx), null)
})

Deno.test('a bundle whose version_parent we do not mirror is still dropped', () => {
	const ctx = context([node(2, { gameType: GameType.BUNDLE, versionParent: 999 })])
	assertEquals(resolveRoot(2, ctx), null)
})

Deno.test('an orphan child becomes its own title', () => {
	// Parent id points at a game we do not have. The child still needs a title,
	// because user records may already reference it.
	const ctx = context([node(2, { gameType: GameType.DLC_ADDON, parentGame: 999 })])
	assertEquals(resolveRoot(2, ctx), 2)
})

Deno.test('a child of a tombstoned parent becomes its own title', () => {
	const ctx = context([
		node(1, { deleted: true }),
		node(2, { gameType: GameType.DLC_ADDON, parentGame: 1 }),
	])
	assertEquals(resolveRoot(2, ctx), 2)
})

Deno.test('a parent cycle terminates', () => {
	const ctx = context([
		node(1, { gameType: GameType.DLC_ADDON, parentGame: 2 }),
		node(2, { gameType: GameType.DLC_ADDON, parentGame: 1 }),
	])
	assertEquals(resolveRoot(1, ctx), 1)
})

Deno.test('a game we have never mirrored resolves to nothing', () => {
	assertEquals(resolveRoot(42, context([])), null)
})

Deno.test('override fold_into redirects to the target', () => {
	const ctx = context([node(1), node(2)], {
		2: { action: 'fold_into', targetGameId: 1 },
	})
	assertEquals(resolveRoot(2, ctx), 1)
})

Deno.test('override fold_into follows a chain', () => {
	const ctx = context([node(1), node(2), node(3)], {
		3: { action: 'fold_into', targetGameId: 2 },
		2: { action: 'fold_into', targetGameId: 1 },
	})
	assertEquals(resolveRoot(3, ctx), 1)
})

Deno.test('override keep_separate stops a game folding', () => {
	const ctx = context([node(1), node(2, { gameType: GameType.DLC_ADDON, parentGame: 1 })], {
		2: { action: 'keep_separate', targetGameId: null },
	})
	assertEquals(resolveRoot(2, ctx), 2)
})

Deno.test('override hide removes a game entirely', () => {
	const ctx = context([node(1)], { 1: { action: 'hide', targetGameId: null } })
	assertEquals(resolveRoot(1, ctx), null)
})

Deno.test('an override cycle terminates', () => {
	const ctx = context([node(1), node(2)], {
		1: { action: 'fold_into', targetGameId: 2 },
		2: { action: 'fold_into', targetGameId: 1 },
	})
	assertEquals(resolveRoot(1, ctx), 1)
})

Deno.test('foldTypeOf reads the member type', () => {
	const root = node(1)
	assertEquals(foldTypeOf(root, root, false), 'root')
	assertEquals(foldTypeOf(node(2, { gameType: GameType.PORT }), root, false), 'port')
	assertEquals(foldTypeOf(node(2, { gameType: GameType.DLC_ADDON }), root, false), 'dlc')
	assertEquals(foldTypeOf(node(2, { gameType: GameType.EXPANSION }), root, false), 'expansion')
	assertEquals(foldTypeOf(node(2, { gameType: GameType.REMASTER }), root, false), 'remaster')
	assertEquals(foldTypeOf(node(2, { versionParent: 1 }), root, false), 'version')
	assertEquals(foldTypeOf(node(2, { gameType: GameType.DLC_ADDON }), root, true), 'override')
})

Deno.test("the root's own parent, folded in by override, is the original", () => {
	// Super Mario Bros. 2 (a port of Doki-doki Panic in IGDB) crowned as the
	// title: the original folds under the port it spawned.
	const original = node(41233)
	const port = node(1067, { gameType: GameType.PORT, parentGame: 41233 })
	assertEquals(foldTypeOf(original, port, true), 'original')
	// Unrelated overridden members still read as hand-folded editions.
	assertEquals(foldTypeOf(node(3), port, true), 'override')
})

Deno.test('a crowned port keeps its title and its original folds into it', () => {
	const ctx = context([node(41233), node(1067, { gameType: GameType.PORT, parentGame: 41233 })], {
		1067: { action: 'keep_separate', targetGameId: null },
		41233: { action: 'fold_into', targetGameId: 1067 },
	})
	assertEquals(resolveRoot(1067, ctx), 1067)
	assertEquals(resolveRoot(41233, ctx), 1067)
})

Deno.test('contributionOf routes each fold type', () => {
	assertEquals(contributionOf('dlc'), 'expansions')
	assertEquals(contributionOf('expansion'), 'expansions')
	assertEquals(contributionOf('remaster'), 'editions')
	assertEquals(contributionOf('version'), 'editions')
	assertEquals(contributionOf('override'), 'editions')
	assertEquals(contributionOf('original'), 'original')
	assertEquals(contributionOf('port'), 'platforms-only')
	assertEquals(contributionOf('root'), 'platforms-only')
})
