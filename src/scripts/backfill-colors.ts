/**
 * Compute cover colours for every live title that has none.
 *
 *   deno task colors:backfill
 *   deno task colors:backfill -- --limit=500      # a slice
 *   deno task colors:backfill -- --concurrency=8
 *
 * Safe to stop and re-run: the pending set is a query over `titles` left-joined
 * to `cover_colors`, so whatever did not finish is simply still pending. Nothing
 * is queued and nothing is lost.
 *
 * This is a lot of CDN fetches — one per distinct cover — so it is deliberately
 * a separate, opt-in command rather than something a derive run triggers.
 */

import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { backfillCoverColors, pendingCoverCount, pendingCoverIds } from '../derive/colors.js'

const flags = new Set(Deno.args.filter((a) => a.startsWith('--')))
const valueOf = (name: string, fallback: number) => {
	const flag = [...flags].find((f) => f.startsWith(`--${name}=`))
	return flag ? Number(flag.split('=')[1]) : fallback
}

const limit = valueOf('limit', Number.POSITIVE_INFINITY)
const concurrency = valueOf('concurrency', 4)
const BATCH = 200

const started = Date.now()
const total = await pendingCoverCount()
console.log(`${total.toLocaleString()} covers without colours\n`)

let attempted = 0
let stored = 0
let failed = 0

while (attempted < limit) {
	const batchSize = Math.min(BATCH, limit - attempted)
	const ids = await pendingCoverIds(batchSize)
	if (ids.length === 0) break

	const result = await backfillCoverColors(ids, concurrency)
	attempted += result.attempted
	stored += result.stored
	failed += result.failed

	const rate = attempted / ((Date.now() - started) / 1000)
	logger.info({ attempted, stored, failed, perSecond: Math.round(rate) }, 'Cover colours')

	// A batch where nothing stored means every id failed — most likely the
	// images host is unhappy. Stop rather than grind through the rest.
	if (result.stored === 0 && result.attempted > 0) {
		logger.error('Whole batch failed; stopping')
		break
	}
}

console.log('')
console.log(`attempted  ${attempted.toLocaleString()}`)
console.log(`stored     ${stored.toLocaleString()}`)
console.log(`failed     ${failed.toLocaleString()}`)
console.log(`remaining  ${(await pendingCoverCount()).toLocaleString()}`)
console.log(`elapsed    ${((Date.now() - started) / 1000).toFixed(1)}s`)

await sql.end()
