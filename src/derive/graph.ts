import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import {
	type FoldContext,
	type FoldOverride,
	type FoldType,
	foldTypeOf,
	type GameNode,
	resolveRoot,
} from './fold.js'

/**
 * The whole parent graph, in memory.
 *
 * 374k games with five fields each is about 60 MB, which is far cheaper than
 * the alternative: resolving roots with a recursive CTE per title would mean
 * ~309k round trips for a full sweep. Loading the graph once and resolving
 * every game in a single pass takes seconds.
 *
 * This is also the only place membership is computed, so `title_members` and
 * `resolveRoot` cannot drift apart.
 */

export interface Membership {
	/** root id -> its members, root first. */
	byRoot: Map<number, Array<{ gameId: number; foldType: FoldType }>>
	/** game id -> the root it belongs to. */
	rootOf: Map<number, number>
	/** Games that resolve to nothing (bundles, mods, packs, hidden overrides). */
	ignored: number
}

export interface Graph {
	nodes: Map<number, GameNode>
	overrides: Map<number, FoldOverride>
	context: FoldContext
}

export async function loadGraph(): Promise<Graph> {
	const started = Date.now()

	const rows = await sql<
		Array<{
			id: string
			game_type: string | null
			parent_game: string | null
			version_parent: string | null
			deleted_at: Date | null
		}>
	>`
		select id, game_type, parent_game, version_parent, deleted_at from igdb_games
	`

	const nodes = new Map<number, GameNode>()
	for (const row of rows) {
		// postgres.js hands int8 back as a string; see src/mirror/copy.test.ts.
		nodes.set(Number(row.id), {
			id: Number(row.id),
			gameType: row.game_type === null ? null : Number(row.game_type),
			parentGame: row.parent_game === null ? null : Number(row.parent_game),
			versionParent: row.version_parent === null ? null : Number(row.version_parent),
			deleted: row.deleted_at !== null,
		})
	}

	const overrideRows = await sql<
		Array<{ game_id: string; action: string; target_game_id: string | null }>
	>`
		select game_id, action, target_game_id from fold_overrides
	`
	const overrides = new Map<number, FoldOverride>()
	for (const row of overrideRows) {
		overrides.set(Number(row.game_id), {
			action: row.action as FoldOverride['action'],
			targetGameId: row.target_game_id === null ? null : Number(row.target_game_id),
		})
	}

	logger.info(
		{ games: nodes.size, overrides: overrides.size, elapsedMs: Date.now() - started },
		'Loaded parent graph',
	)

	return {
		nodes,
		overrides,
		context: { game: (id) => nodes.get(id), override: (id) => overrides.get(id) },
	}
}

/** Resolve every mirrored game to its title. */
export function computeMembership(graph: Graph): Membership {
	const byRoot = new Map<number, Array<{ gameId: number; foldType: FoldType }>>()
	const rootOf = new Map<number, number>()
	let ignored = 0
	let dangling = 0

	for (const node of graph.nodes.values()) {
		let rootId = resolveRoot(node.id, graph.context)
		if (rootId === null) {
			ignored++
			continue
		}
		// An override can point `fold_into` at a game we do not mirror. Keeping the
		// game as its own title loses nothing; folding it into a root that has no
		// row would produce a title with no name.
		if (!graph.nodes.has(rootId)) {
			dangling++
			rootId = node.id
		}
		rootOf.set(node.id, rootId)
		const foldType = foldTypeOf(node, rootId, graph.overrides.has(node.id))
		const members = byRoot.get(rootId)
		if (members) members.push({ gameId: node.id, foldType })
		else byRoot.set(rootId, [{ gameId: node.id, foldType }])
	}

	// The root must be first: deriveTitle reads members[0] as the title itself.
	// Sort the rest by id so an unchanged title always derives byte-identically.
	for (const members of byRoot.values()) {
		members.sort((a, b) => {
			if (a.foldType === 'root') return -1
			if (b.foldType === 'root') return 1
			return a.gameId - b.gameId
		})
	}

	if (dangling > 0) {
		logger.warn({ dangling }, 'Fold overrides target games we do not mirror')
	}

	return { byRoot, rootOf, ignored }
}
