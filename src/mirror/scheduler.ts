import { config } from '../config.js'
import { requestDrain } from '../derive/worker.js'
import { logger } from '../logger.js'
import { loadAll } from './load.js'

/**
 * The nightly dump load.
 *
 * Webhooks keep us fresh within seconds; this is what makes that safe to rely
 * on. A missed delivery, a webhook IGDB deactivated after five failures, a spell
 * of downtime — all of it self-heals here, because the dump is the full truth
 * and the loader diffs against it. Freshness degrades to 24 hours, never to
 * silently wrong.
 *
 * In-process on a single instance, per the plan's deployment assumption. Two
 * instances would both load; the loader is idempotent so the result would be
 * correct but wasteful, and that is the point to move to a real scheduler.
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000

let timer: ReturnType<typeof setInterval> | undefined
let lastRunDate: string | null = null
let running = false

export interface SchedulerStatus {
	enabled: boolean
	hourUtc: number
	lastRunDate: string | null
	running: boolean
}

export function schedulerStatus(): SchedulerStatus {
	return {
		enabled: config.DUMP_SCHEDULE_ENABLED,
		hourUtc: config.DUMP_LOAD_HOUR,
		lastRunDate,
		running,
	}
}

export function startDumpScheduler(): void {
	if (!config.DUMP_SCHEDULE_ENABLED) {
		logger.info('Dump scheduler disabled (DUMP_SCHEDULE_ENABLED=false)')
		return
	}
	if (timer !== undefined) return

	// Polling the clock rather than computing a delay: a setTimeout for the next
	// run does not survive the process sleeping, and a laptop or a suspended
	// container would simply never fire it.
	timer = setInterval(() => void maybeRun(), CHECK_INTERVAL_MS)
	logger.info({ hourUtc: config.DUMP_LOAD_HOUR }, 'Dump scheduler started')
	void maybeRun()
}

export function stopDumpScheduler(): void {
	if (timer !== undefined) clearInterval(timer)
	timer = undefined
}

async function maybeRun(): Promise<void> {
	if (running) return

	const now = new Date()
	const today = now.toISOString().slice(0, 10)
	if (now.getUTCHours() !== config.DUMP_LOAD_HOUR) return
	// One run per day, however many times the interval fires inside the hour.
	if (lastRunDate === today) return

	lastRunDate = today
	await runDumpLoad('scheduled')
}

/** Load every dump, then hand the resulting dirty titles to the worker. */
export async function runDumpLoad(trigger: string): Promise<void> {
	running = true
	const started = Date.now()
	try {
		const results = await loadAll()
		const loaded = results.filter((r) => r.status === 'loaded')
		const aborted = results.filter((r) => r.status === 'aborted')
		const changed = loaded.reduce((n, r) => n + r.rowsChanged + r.rowsDeleted, 0)

		logger.info(
			{
				trigger,
				loaded: loaded.length,
				skipped: results.length - loaded.length - aborted.length,
				aborted: aborted.length,
				changed,
				elapsedMs: Date.now() - started,
			},
			'Dump load finished',
		)

		for (const result of aborted) {
			logger.error({ endpoint: result.endpoint, reason: result.reason }, 'Dump endpoint aborted')
		}

		if (changed > 0) requestDrain('dump')
	} catch (error) {
		logger.error({ error, trigger }, 'Dump load failed')
	} finally {
		running = false
	}
}
