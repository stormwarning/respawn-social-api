import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { clearDirty } from './dirty.js'
import { computeMembership, loadGraph, type Membership } from './graph.js'
import { deriveTitle } from './index.js'
import { loadInputs, loadOverridesVersion, loadRefs } from './load.js'
import { deleteTitles, writeTitles } from './write.js'

/**
 * Deriving many titles at once.
 *
 * Shared by `derive:all` and by the worker when it has a large backlog. The
 * expensive part is `loadGraph`: 374k games, ~60 MB, about 200 ms. Paying that
 * once and resolving every root in a single pass is what makes a full rebuild
 * take a minute instead of hours — but it is also why the worker only comes
 * here when there is enough work to justify it, and uses `deriveOne` otherwise.
 */

const BATCH = 400

export interface SweepResult {
	titles: number
	written: number
	skipped: number
	missing: number
	removed: number
	ignored: number
	elapsedMs: number
}

export interface SweepOptions {
	/** Restrict the sweep to these title ids. Omit to rebuild everything. */
	only?: number[]
	/** Delete rows from `dirty_titles` as each batch completes. */
	clearDirtyRows?: boolean
	limit?: number
	onProgress?: (done: number, total: number) => void
}

export async function sweep(options: SweepOptions = {}): Promise<SweepResult> {
	const started = Date.now()

	const graph = await loadGraph()
	const membership = computeMembership(graph)
	const refs = await loadRefs()
	const overridesVersion = await loadOverridesVersion()

	let rootIds = [...membership.byRoot.keys()].sort((a, b) => a - b)

	let removed = 0
	if (options.only) {
		const wanted = new Set(options.only)
		// An id that is no longer a root has stopped being a title — it folded
		// into something else, or became a type we do not ingest. Removing it is
		// as much a part of staying fresh as rebuilding the survivors.
		const gone = options.only.filter((id) => !membership.byRoot.has(id))
		if (gone.length > 0) {
			await deleteTitles(gone)
			// Clear their queue entries too. They are not in `rootIds`, so the loop
			// below never reaches them — without this they stay dirty forever, and
			// every subsequent run re-processes the same ids and reports them as
			// still pending.
			if (options.clearDirtyRows) await clearDirty(gone)
			removed = gone.length
		}
		rootIds = rootIds.filter((id) => wanted.has(id))
	} else {
		// A full rebuild has the same obligation: a title whose id no longer
		// resolves to itself — folded by a new override, or by IGDB re-parenting
		// it — must go, or its stale row keeps serving from search and browse
		// while `title_members` says the id belongs to someone else.
		const rows = await sql<Array<{ id: string }>>`select id from titles`
		const gone = rows.map((r) => Number(r.id)).filter((id) => !membership.byRoot.has(id))
		if (gone.length > 0) {
			await deleteTitles(gone)
			if (options.clearDirtyRows) await clearDirty(gone)
			removed = gone.length
		}
	}

	if (options.limit !== undefined) rootIds = rootIds.slice(0, options.limit)

	logger.info(
		{
			games: graph.nodes.size,
			titles: membership.byRoot.size,
			selected: rootIds.length,
			ignored: membership.ignored,
			overridesVersion,
		},
		'Sweep starting',
	)

	const existing = await loadSourceHashes(rootIds, options.only !== undefined)

	let written = 0
	let skipped = 0
	let missing = 0

	for (let i = 0; i < rootIds.length; i += BATCH) {
		const batch = rootIds.slice(i, i + BATCH)
		const inputs = await loadInputs(batch, membership, overridesVersion)
		missing += batch.length - inputs.length

		const derived = []
		for (const input of inputs) {
			const title = deriveTitle(input, refs)
			if (existing.get(title.id) === title.sourceHash) skipped++
			else derived.push(title)
		}

		await writeTitles(derived)
		written += derived.length

		if (options.clearDirtyRows) await clearDirty(batch)
		options.onProgress?.(Math.min(i + BATCH, rootIds.length), rootIds.length)
	}

	return {
		titles: membership.byRoot.size,
		written,
		skipped,
		missing,
		removed,
		ignored: membership.ignored,
		elapsedMs: Date.now() - started,
	}
}

/**
 * What we already hold, so an unchanged title costs one string comparison.
 *
 * For a full sweep this is one scan of 309k rows; for a targeted one it is an
 * indexed lookup of the ids in play.
 */
async function loadSourceHashes(
	rootIds: number[],
	targeted: boolean,
): Promise<Map<number, string>> {
	const rows = targeted
		? await sql<Array<{ id: string; source_hash: string }>>`
			select id, source_hash from titles where id = any(${rootIds})
		`
		: await sql<Array<{ id: string; source_hash: string }>>`
			select id, source_hash from titles
		`
	return new Map(rows.map((r) => [Number(r.id), r.source_hash]))
}

export type { Membership }
