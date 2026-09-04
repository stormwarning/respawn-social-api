/**
 * One scheduled refresh: pull the latest dumps, rebuild what they changed, exit.
 *
 *   deno task cron:refresh
 *
 * This is the whole freshness story when the API service is allowed to sleep.
 * The in-process scheduler in `src/mirror/scheduler.ts` and the `LISTEN`-driven
 * worker both assume a process that stays alive; a sleeping container has
 * neither, and webhooks are worse there still — IGDB deactivates a webhook
 * after five failed deliveries, and a cold start is exactly how you collect
 * five.
 *
 * So Railway runs this as a scheduled service instead: it starts, does the
 * work, and exits. Nothing to keep awake, nothing to authenticate, no HTTP
 * timeout to fit inside.
 *
 * Safe to run at any time and safe to run twice. The dump loader skips
 * endpoints whose dump has not been regenerated, and the derive skips titles
 * whose `source_hash` has not moved.
 */

import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { claimBatch, pendingCount } from '../derive/dirty.js'
import { sweep } from '../derive/sweep.js'
import { loadAll } from '../mirror/load.js'

const started = Date.now()
let failed = false

// ---------------------------------------------------------------------------
// 1. Pull the dumps.
// ---------------------------------------------------------------------------

const results = await loadAll()

const loaded = results.filter((r) => r.status === 'loaded')
const aborted = results.filter((r) => r.status === 'aborted')
const changed = loaded.reduce((n, r) => n + r.rowsChanged + r.rowsDeleted, 0)
const dirtied = loaded.reduce((n, r) => n + r.titlesDirtied, 0)

for (const result of aborted) {
	// One endpoint's schema drifting must not stop the others, but it does mean
	// this run is a partial success and the exit code should say so.
	failed = true
	logger.error({ endpoint: result.endpoint, reason: result.reason }, 'Dump endpoint aborted')
}

logger.info(
	{
		loaded: loaded.length,
		skipped: results.length - loaded.length - aborted.length,
		aborted: aborted.length,
		rowsChanged: changed,
		titlesDirtied: dirtied,
	},
	'Dumps loaded',
)

// ---------------------------------------------------------------------------
// 2. Rebuild whatever that changed.
// ---------------------------------------------------------------------------

const pending = await pendingCount()
let written = 0
let skipped = 0

if (pending > 0) {
	// One sweep over the dirty set. It loads the parent graph once (~200 ms) and
	// resolves every root in a pass, which is the right shape here — a nightly
	// dump dirties tens of thousands of titles, and walking each subtree
	// separately would take hours.
	const ids = await claimBatch(pending)
	const result = await sweep({ only: ids, clearDirtyRows: true })
	written = result.written
	skipped = result.skipped

	logger.info(
		{ pending, written, skipped, removed: result.removed, elapsedMs: result.elapsedMs },
		'Titles rebuilt',
	)
} else {
	logger.info('Nothing to rebuild')
}

const remaining = await pendingCount()
if (remaining > 0) {
	// Work queued while the sweep ran. Not an error — the next run takes it.
	logger.warn({ remaining }, 'Titles still queued; the next run will take them')
}

const elapsed = (Date.now() - started) / 1000
console.log('')
console.log(`endpoints loaded  ${loaded.length}`)
console.log(`  aborted         ${aborted.length}`)
console.log(`rows changed      ${changed.toLocaleString()}`)
console.log(`titles queued     ${dirtied.toLocaleString()}`)
console.log(`  rebuilt         ${written.toLocaleString()}`)
console.log(`  unchanged       ${skipped.toLocaleString()}`)
console.log(`elapsed           ${elapsed.toFixed(1)}s`)

await sql.end()

// Non-zero so a failed endpoint is visible in Railway's run history rather than
// only in the logs.
Deno.exit(failed ? 1 : 0)
