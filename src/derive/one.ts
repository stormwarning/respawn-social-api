import { sql } from '../db/client.js'
import {
	type FoldContext,
	type FoldOverride,
	type FoldType,
	foldTypeOf,
	type GameNode,
	resolveRoot,
} from './fold.js'
import type { Membership } from './graph.js'
import { deriveTitle } from './index.js'
import { loadInputs, loadOverridesVersion, loadRefs } from './load.js'
import { deleteTitles, writeTitles } from './write.js'
import type { DeriveRefs } from './index.js'

/**
 * Derive ONE title, without loading the whole parent graph.
 *
 * `derive:all` holds all 374k games in memory and resolves every root in one
 * pass, which is right for a sweep and hopeless for a request: a page load
 * cannot afford a 200 ms graph load plus 60 MB of allocation. This walks only
 * the subtree that actually matters — the seed's ancestors, then everything
 * descending from the root it lands on — which is a handful of small queries.
 *
 * Used by the §5.5 unknown-id fallback, and (from Phase 4) by the derive worker
 * draining `dirty_titles`.
 */

/** Platform and genre lookups are 243 rows total and change ~never. */
let cachedRefs: { refs: DeriveRefs; at: number } | null = null
const REFS_TTL_MS = 5 * 60 * 1000

async function refs(): Promise<DeriveRefs> {
	if (cachedRefs && Date.now() - cachedRefs.at < REFS_TTL_MS) return cachedRefs.refs
	const loaded = await loadRefs()
	cachedRefs = { refs: loaded, at: Date.now() }
	return loaded
}

interface NodeRow {
	id: string
	game_type: string | null
	parent_game: string | null
	version_parent: string | null
	deleted_at: Date | string | null
}

function toNode(row: NodeRow): GameNode {
	return {
		id: Number(row.id),
		gameType: row.game_type === null ? null : Number(row.game_type),
		parentGame: row.parent_game === null ? null : Number(row.parent_game),
		versionParent: row.version_parent === null ? null : Number(row.version_parent),
		deleted: row.deleted_at !== null,
	}
}

const NODE_SELECT = sql`select id, game_type, parent_game, version_parent, deleted_at from igdb_games`

/** Cheap guard against a pathological chain; the real catalogue is far shallower. */
const MAX_DEPTH = 24

async function loadAncestors(seedId: number, nodes: Map<number, GameNode>): Promise<void> {
	let frontier = [seedId]
	for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
		const rows = await sql<NodeRow[]>`${NODE_SELECT} where id = any(${frontier})`
		const next: number[] = []
		for (const row of rows) {
			const node = toNode(row)
			if (nodes.has(node.id)) continue
			nodes.set(node.id, node)
			for (const parent of [node.versionParent, node.parentGame]) {
				if (parent !== null && !nodes.has(parent)) next.push(parent)
			}
		}
		frontier = next
	}
}

async function loadDescendants(rootId: number, nodes: Map<number, GameNode>): Promise<void> {
	let frontier = [rootId]
	for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
		const rows = await sql<NodeRow[]>`
			${NODE_SELECT} where parent_game = any(${frontier}) or version_parent = any(${frontier})
		`
		const next: number[] = []
		for (const row of rows) {
			const node = toNode(row)
			if (nodes.has(node.id)) continue
			nodes.set(node.id, node)
			next.push(node.id)
		}
		frontier = next
	}
}

async function loadOverrides(ids: number[]): Promise<Map<number, FoldOverride>> {
	const out = new Map<number, FoldOverride>()
	if (ids.length === 0) return out
	const rows = await sql<Array<{ game_id: string; action: string; target_game_id: string | null }>>`
		select game_id, action, target_game_id from fold_overrides where game_id = any(${ids})
	`
	for (const row of rows) {
		out.set(Number(row.game_id), {
			action: row.action as FoldOverride['action'],
			targetGameId: row.target_game_id === null ? null : Number(row.target_game_id),
		})
	}
	return out
}

export interface DeriveOneResult {
	titleId: number | null
	/** Titles that lost their last member and were removed. */
	removed: number[]
}

/**
 * Rebuild the title that `gameId` belongs to, and return its id.
 *
 * Returns `titleId: null` when the game resolves to nothing — a bundle, a mod,
 * or a `hide` override. That is a legitimate answer, not a failure.
 */
export async function deriveOne(gameId: number): Promise<DeriveOneResult> {
	const nodes = new Map<number, GameNode>()
	await loadAncestors(gameId, nodes)
	if (!nodes.has(gameId)) return { titleId: null, removed: [] }

	// Overrides can redirect the climb, so they have to be in hand before it.
	let overrides = await loadOverrides([...nodes.keys()])
	const context: FoldContext = {
		game: (id) => nodes.get(id),
		override: (id) => overrides.get(id),
	}

	const rootId = resolveRoot(gameId, context)
	if (rootId === null) {
		// The game no longer belongs anywhere. If it used to be a title, that
		// title has to go, or it keeps serving from a stale row.
		const removed = await dropOrphanedTitle(gameId)
		return { titleId: null, removed }
	}

	await loadDescendants(rootId, nodes)
	overrides = await loadOverrides([...nodes.keys()])
	const rootNode = nodes.get(rootId)
	if (!rootNode) return { titleId: null, removed: [] }

	const members: Array<{ gameId: number; foldType: FoldType }> = []
	for (const node of nodes.values()) {
		if (resolveRoot(node.id, context) !== rootId) continue
		members.push({ gameId: node.id, foldType: foldTypeOf(node, rootNode, overrides.has(node.id)) })
	}
	members.sort((a, b) => {
		if (a.foldType === 'root') return -1
		if (b.foldType === 'root') return 1
		return a.gameId - b.gameId
	})

	// `similar` needs each referenced game resolved to a title. Those live
	// outside this subtree, so read them from the members table the sweep
	// already built rather than walking more of the graph.
	const membership: Membership = {
		byRoot: new Map([[rootId, members]]),
		rootOf: await rootsOfSimilar(rootId),
		ignored: 0,
	}
	for (const member of members) membership.rootOf.set(member.gameId, rootId)

	const inputs = await loadInputs([rootId], membership, await loadOverridesVersion())
	const input = inputs[0]
	if (!input) return { titleId: null, removed: [] }

	await writeTitles([deriveTitle(input, await refs())])

	// A member that used to be its own title must stop being one.
	const removed = await dropSupersededTitles(
		rootId,
		members.map((m) => m.gameId),
	)
	return { titleId: rootId, removed }
}

async function rootsOfSimilar(rootId: number): Promise<Map<number, number>> {
	const rows = await sql<Array<{ game_id: string; title_id: string }>>`
		select m.game_id, m.title_id
		from igdb_games g
		join title_members m on m.game_id = any(g.similar_games)
		where g.id = ${rootId}
	`
	return new Map(rows.map((r) => [Number(r.game_id), Number(r.title_id)]))
}

/** A game that stopped resolving anywhere: drop the title it used to be. */
async function dropOrphanedTitle(gameId: number): Promise<number[]> {
	const rows = await sql<Array<{ id: string }>>`select id from titles where id = ${gameId}`
	if (rows.length === 0) return []
	await deleteTitles([gameId])
	return [gameId]
}

/** Members that used to be roots in their own right are no longer titles. */
async function dropSupersededTitles(rootId: number, memberIds: number[]): Promise<number[]> {
	const others = memberIds.filter((id) => id !== rootId)
	if (others.length === 0) return []
	const rows = await sql<Array<{ id: string }>>`
		select id from titles where id = any(${others})
	`
	const stale = rows.map((r) => Number(r.id))
	if (stale.length > 0) await deleteTitles(stale)
	return stale
}
