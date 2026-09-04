/**
 * Rebuild every derived title from the canonical mirror.
 *
 *   deno task derive:all
 *   deno task derive:all -- --fresh    # truncate the derived tables first
 *   deno task derive:all -- --limit=50 # a slice, for iterating
 *
 * Safe to re-run. Titles whose inputs have not changed are skipped by
 * `source_hash`, so a second full run over unchanged data writes nothing.
 */

import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { computeMembership, loadGraph } from '../derive/graph.js'
import { deriveTitle } from '../derive/index.js'
import { loadInputs, loadOverridesVersion, loadRefs } from '../derive/load.js'
import { writeTitles } from '../derive/write.js'

const flags = new Set(Deno.args.filter((a) => a.startsWith('--')))
const limitFlag = [...flags].find((f) => f.startsWith('--limit='))
const limit = limitFlag ? Number(limitFlag.split('=')[1]) : undefined

const BATCH = 400

const started = Date.now()

if (flags.has('--fresh')) {
	logger.warn('Truncating derived tables')
	await sql`truncate title_terms, title_members, titles`
}

const graph = await loadGraph()
const membership = computeMembership(graph)
const refs = await loadRefs()
const overridesVersion = await loadOverridesVersion()

let rootIds = [...membership.byRoot.keys()].sort((a, b) => a - b)
if (limit !== undefined) rootIds = rootIds.slice(0, limit)

logger.info(
	{
		games: graph.nodes.size,
		titles: membership.byRoot.size,
		ignored: membership.ignored,
		platforms: refs.platforms.size,
		genres: refs.genres.size,
		overridesVersion,
	},
	'Membership computed',
)

// What we already have, so an unchanged title costs nothing but the comparison.
const existing = new Map<number, string>()
for (const row of await sql<Array<{ id: string; source_hash: string }>>`
		select id, source_hash from titles
	`) {
	existing.set(Number(row.id), row.source_hash)
}

let written = 0
let skipped = 0
let missing = 0
let processed = 0

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
	processed += batch.length

	if (processed % 20_000 < BATCH) {
		const rate = processed / ((Date.now() - started) / 1000)
		logger.info(
			{ processed, total: rootIds.length, written, skipped, perSecond: Math.round(rate) },
			'Deriving',
		)
	}
}

const elapsed = (Date.now() - started) / 1000
console.log('')
console.log(`titles          ${membership.byRoot.size.toLocaleString()}`)
console.log(`  written       ${written.toLocaleString()}`)
console.log(`  skipped       ${skipped.toLocaleString()} (source_hash unchanged)`)
console.log(`  root missing  ${missing.toLocaleString()}`)
console.log(`games ignored   ${membership.ignored.toLocaleString()} (bundles, mods, packs, hidden)`)
console.log(`elapsed         ${elapsed.toFixed(1)}s`)

await sql.end()
