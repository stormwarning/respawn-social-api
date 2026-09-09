/**
 * Rebuild every derived title from the canonical mirror.
 *
 *   deno task derive:all
 *   deno task derive:all -- --fresh    # truncate the derived tables first
 *   deno task derive:all -- --limit=50 # a slice, for iterating
 *
 * Safe to re-run. Titles whose inputs have not changed are skipped by
 * `source_hash`, so a second full run over unchanged data writes nothing.
 *
 * The work itself lives in src/derive/sweep.ts, shared with the derive worker —
 * a full rebuild and a worker draining a nightly backlog are the same
 * operation over a different set of ids.
 */

import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { sweep } from '../derive/sweep.js'

const flags = new Set(Deno.args.filter((a) => a.startsWith('--')))
const limitFlag = [...flags].find((f) => f.startsWith('--limit='))
const limit = limitFlag ? Number(limitFlag.split('=')[1]) : undefined

if (flags.has('--fresh')) {
	logger.warn('Truncating derived tables')
	await sql`truncate title_terms, title_members, titles`
}

let lastLogged = 0
const result = await sweep({
	limit,
	// Every title the sweep touches is fresh afterwards, so its queue entry is
	// stale. Without this a full rebuild leaves the whole backlog behind and the
	// worker re-derives all 309k titles again for nothing.
	clearDirtyRows: true,
	onProgress(done, total) {
		if (done - lastLogged < 20_000 && done !== total) return
		lastLogged = done
		logger.info({ done, total }, 'Deriving')
	},
})

console.log('')
console.log(`titles          ${result.titles.toLocaleString()}`)
console.log(`  written       ${result.written.toLocaleString()}`)
console.log(`  skipped       ${result.skipped.toLocaleString()} (source_hash unchanged)`)
console.log(`  root missing  ${result.missing.toLocaleString()}`)
console.log(`  removed       ${result.removed.toLocaleString()} (no longer a root)`)
console.log(`games ignored   ${result.ignored.toLocaleString()} (bundles, mods, packs, hidden)`)
console.log(`elapsed         ${(result.elapsedMs / 1000).toFixed(1)}s`)

await sql.end()
