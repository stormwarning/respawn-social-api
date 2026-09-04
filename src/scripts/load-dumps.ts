/**
 * Load IGDB data dumps into the canonical `igdb_*` tables.
 *
 *   deno task db:dumps                    # every endpoint, download from IGDB
 *   deno task db:dumps games covers       # just these
 *   deno task db:dumps -- --local         # read the CSVs already in .dumps/
 *   deno task db:dumps -- --local=/tmp/x  # ...from somewhere else
 *   deno task db:dumps -- --force         # reload even if the dump is unchanged
 *
 * Safe to re-run. A run against an unchanged dump reports `changed=0` and
 * finishes in seconds, because the merge diffs on IGDB's per-row checksum
 * rather than rewriting the table.
 */

import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { ENDPOINT_NAMES, type Endpoint } from '../mirror/endpoints.js'
import { loadAll, loadEndpoint, type LoadResult } from '../mirror/load.js'

const args = Deno.args.filter((a) => !a.startsWith('--'))
const flags = new Set(Deno.args.filter((a) => a.startsWith('--')))

const local = [...flags].find((f) => f === '--local' || f.startsWith('--local='))

const options = {
	force: flags.has('--force'),
	localDir: local ? local.split('=')[1] || '.dumps' : undefined,
}

const unknown = args.filter((a) => !ENDPOINT_NAMES.includes(a as Endpoint))
if (unknown.length > 0) {
	console.error(`Unknown endpoint(s): ${unknown.join(', ')}`)
	console.error(`Known: ${ENDPOINT_NAMES.join(', ')}`)
	Deno.exit(2)
}

const started = Date.now()
const results: LoadResult[] =
	args.length > 0 ? await sequentially(args as Endpoint[]) : await loadAll(options)

async function sequentially(endpoints: Endpoint[]) {
	const out: LoadResult[] = []
	for (const endpoint of endpoints) {
		try {
			out.push(await loadEndpoint(endpoint, options))
		} catch (error) {
			logger.error({ error, endpoint }, 'Dump load failed')
			out.push({
				endpoint,
				status: 'aborted',
				reason: error instanceof Error ? error.message : String(error),
				rowsLoaded: 0,
				rowsChanged: 0,
				rowsDeleted: 0,
				elapsedMs: 0,
			})
		}
	}
	return out
}

const pad = (s: string | number, n: number) => String(s).padStart(n)
console.log('')
console.log('endpoint             status        loaded   changed   deleted     time')
for (const r of results) {
	console.log(
		`${r.endpoint.padEnd(20)} ${r.status.padEnd(9)} ${pad(r.rowsLoaded.toLocaleString(), 9)} ${pad(
			r.rowsChanged.toLocaleString(),
			9,
		)} ${pad(r.rowsDeleted.toLocaleString(), 9)} ${pad(`${(r.elapsedMs / 1000).toFixed(1)}s`, 8)}`,
	)
	if (r.reason) console.log(`  └─ ${r.reason}`)
}
console.log(`\nTotal ${((Date.now() - started) / 1000).toFixed(1)}s`)

await sql.end()

// A single aborted endpoint is a non-zero exit so CI/cron notices, but the
// other endpoints have already been loaded by this point.
Deno.exit(results.some((r) => r.status === 'aborted') ? 1 : 0)
