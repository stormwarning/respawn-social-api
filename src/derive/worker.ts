import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { claimBatch, clearDirty, pendingCount } from './dirty.js'
import { deriveOne } from './one.js'
import { sweep } from './sweep.js'

/**
 * The derive worker.
 *
 * Titles go stale when a dump or a webhook moves their inputs; something has to
 * rebuild them, and it must not be the request path. This drains
 * `dirty_titles` in the background, woken by `LISTEN` so an intra-day webhook
 * shows up in seconds rather than at the next poll.
 *
 * It picks its strategy by backlog size, because the two paths have opposite
 * cost profiles:
 *
 *   - A handful of titles: `deriveOne` each, walking just their subtrees. A few
 *     small indexed queries per title, no graph load.
 *   - A nightly dump's worth: one `sweep`, which loads the whole 374k-game
 *     parent graph once (~200 ms) and resolves every root in a single pass.
 *     Running `deriveOne` 46,000 times would take hours.
 *
 * The poll is a safety net, not the mechanism. A NOTIFY can be missed if the
 * connection drops at the wrong moment, and a title stuck dirty forever is a
 * silent staleness bug — so we also look every 60 seconds regardless.
 */

/** Above this many pending titles, one graph load is cheaper than N subtree walks. */
const BULK_THRESHOLD = 500
/** Titles per `deriveOne` pass, so a burst cannot monopolise the connection pool. */
const SMALL_BATCH = 50
const POLL_MS = 60_000

let running = false
let draining = false
let timer: ReturnType<typeof setInterval> | undefined
let listener: { unlisten: () => Promise<void> } | undefined

export interface WorkerStatus {
	running: boolean
	draining: boolean
	lastDrainAt: string | null
	lastError: string | null
	derivedSinceStart: number
}

const status: WorkerStatus = {
	running: false,
	draining: false,
	lastDrainAt: null,
	lastError: null,
	derivedSinceStart: 0,
}

export function workerStatus(): WorkerStatus {
	return { ...status, running, draining }
}

export async function startDeriveWorker(): Promise<void> {
	if (running) return
	running = true
	status.running = true

	// A dedicated connection: LISTEN holds it for the life of the process, and
	// taking one out of the shared pool would quietly shrink it.
	listener = await sql.listen('dirty_titles', () => {
		void drain('notify')
	})

	timer = setInterval(() => void drain('poll'), POLL_MS)

	logger.info({ pollMs: POLL_MS, bulkThreshold: BULK_THRESHOLD }, 'Derive worker started')

	// Anything left dirty from a previous run — a crash mid-drain, or a dump
	// loaded while the process was down — is picked up now rather than at the
	// first poll.
	void drain('startup')
}

export async function stopDeriveWorker(): Promise<void> {
	running = false
	status.running = false
	if (timer !== undefined) clearInterval(timer)
	timer = undefined
	await listener?.unlisten()
	listener = undefined
}

/**
 * Drain the queue.
 *
 * Re-entrant calls are dropped rather than queued: a burst of webhooks fires
 * many NOTIFYs, and they all want the same thing done once. The loop re-checks
 * `pendingCount` afterwards, so work arriving mid-drain is not stranded.
 */
async function drain(trigger: string): Promise<void> {
	if (draining || !running) return
	draining = true
	status.draining = true

	try {
		for (;;) {
			const pending = await pendingCount()
			if (pending === 0) break

			if (pending >= BULK_THRESHOLD) {
				const ids = await claimBatch(pending)
				logger.info({ trigger, pending }, 'Derive worker: bulk sweep')
				const result = await sweep({ only: ids, clearDirtyRows: true })
				status.derivedSinceStart += result.written
				logger.info(
					{ written: result.written, skipped: result.skipped, elapsedMs: result.elapsedMs },
					'Derive worker: bulk sweep done',
				)
				// Anything still queued was added during the sweep; loop again.
				continue
			}

			const ids = await claimBatch(SMALL_BATCH)
			for (const titleId of ids) {
				await deriveOne(titleId)
				status.derivedSinceStart++
			}
			await clearDirty(ids)
			logger.debug({ trigger, count: ids.length }, 'Derive worker: drained')
		}

		status.lastDrainAt = new Date().toISOString()
		status.lastError = null
	} catch (error) {
		// Never let the worker die. The rows stay dirty and the next poll retries;
		// a crash here would stop all freshness silently.
		status.lastError = error instanceof Error ? error.message : String(error)
		logger.error({ error, trigger }, 'Derive worker drain failed')
	} finally {
		draining = false
		status.draining = false
	}
}

/** Force a drain now. Used by the dump scheduler once a load finishes. */
export function requestDrain(reason: string): void {
	void drain(reason)
}
