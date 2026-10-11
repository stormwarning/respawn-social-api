import { config } from '../config.js'
import { logger } from '../logger.js'
import { syncDue, type SyncDueResult } from './run.js'

/**
 * The play sync worker: every few minutes, poll whichever linked accounts have
 * gone stale.
 *
 * Checking often and syncing only what is due spreads accounts out over the
 * interval instead of polling them all in one burst. An account linked at 9:07
 * is next polled around 9:37, not at the top of the hour with everyone else.
 *
 * Off unless PLAY_SYNC_ENABLED, for a process that stays alive. A deployment
 * that sleeps runs `deno task cron:sync` on a schedule instead; the two can
 * overlap safely, since `syncDue` claims accounts before polling them.
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000

let timer: ReturnType<typeof setInterval> | undefined
let running = false
let lastRunAt: string | null = null
let lastResult: SyncDueResult | null = null

export interface SyncWorkerStatus {
	enabled: boolean
	running: boolean
	lastRunAt: string | null
	lastResult: SyncDueResult | null
}

export function syncWorkerStatus(): SyncWorkerStatus {
	return { enabled: config.PLAY_SYNC_ENABLED, running, lastRunAt, lastResult }
}

export function startSyncWorker(): void {
	if (!config.PLAY_SYNC_ENABLED) {
		logger.info('Play sync worker disabled (PLAY_SYNC_ENABLED=false)')
		return
	}
	if (!config.STEAM_API_KEY) {
		logger.warn('Play sync worker enabled without STEAM_API_KEY; Steam accounts will error')
	}
	if (timer !== undefined) return

	timer = setInterval(() => void tick(), CHECK_INTERVAL_MS)
	logger.info({ intervalMinutes: config.PLAY_SYNC_INTERVAL_MINUTES }, 'Play sync worker started')
	void tick()
}

export function stopSyncWorker(): void {
	if (timer !== undefined) clearInterval(timer)
	timer = undefined
}

async function tick(): Promise<void> {
	if (running) return
	running = true
	try {
		lastResult = await syncDue()
		lastRunAt = new Date().toISOString()
		if (lastResult.synced > 0) logger.info(lastResult, 'Play sync pass finished')
	} catch (error) {
		logger.error({ error }, 'Play sync pass failed')
	} finally {
		running = false
	}
}
