import PQueue from 'p-queue'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { getAccessToken, invalidateToken } from './token.js'

/**
 * Low-level IGDB request client.
 *
 * Backend concept: a RATE LIMITER + REQUEST QUEUE. IGDB allows only 4 requests
 * per second (globally, across ALL our users) and ~8 open at once. If we exceed
 * it we get HTTP 429. The ONLY safe design is to funnel every IGDB call through
 * one shared queue that paces itself under that limit. When a traffic spike
 * causes many cache misses at once, requests simply QUEUE here instead of
 * stampeding IGDB.
 *
 * Nothing outside this `igdb/` folder should ever call IGDB directly — this is
 * the single choke point where the limit is enforced.
 */

const IGDB_BASE_URL = 'https://api.igdb.com/v4'

// p-queue paces our outgoing requests. We deliberately default to 3/sec (not 4)
// to leave headroom for clock skew / retries, and cap concurrency at 8 (IGDB's
// max open-requests limit). The rate is env-tunable (IGDB_RATE_CAP) so a second
// process sharing the global limit can pace itself lower.
const queue = new PQueue({
	intervalCap: config.IGDB_RATE_CAP, // max requests...
	interval: 1000, // ...per 1000ms
	concurrency: 8, // max simultaneously open
})

const MAX_RETRIES = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Make a raw request to an IGDB endpoint using the "apicalypse" query language
 * (IGDB's body-based query format, e.g. `fields name; where id = 5;`).
 *
 * @param endpoint e.g. "games" or "search"
 * @param body     the apicalypse query string
 * @returns parsed JSON array
 */
export async function igdbRequest<T = unknown>(endpoint: string, body: string): Promise<T> {
	// queue.add schedules the work; it won't run until the limiter allows it.
	const result = await queue.add(() => executeWithRetry<T>(endpoint, { method: 'POST', body }))
	// p-queue types `add` as possibly returning void (if the queue is cleared);
	// that never happens here, so assert the real type.
	return result as T
}

/**
 * GET an IGDB endpoint that isn't an apicalypse query.
 *
 * The Data Partner dump endpoints (`/dumps`, `/dumps/{endpoint}`) are plain REST
 * GETs, not apicalypse POSTs, but they draw on the same 4-req/s credential
 * budget — so they go through the same queue.
 *
 * @param endpoint e.g. "dumps" or "dumps/games"
 */
export async function igdbGet<T = unknown>(endpoint: string): Promise<T> {
	const result = await queue.add(() => executeWithRetry<T>(endpoint, { method: 'GET' }))
	return result as T
}

async function executeWithRetry<T>(
	endpoint: string,
	init: { method: string; body?: string },
	attempt = 1,
): Promise<T> {
	const token = await getAccessToken()

	const res = await fetch(`${IGDB_BASE_URL}/${endpoint}`, {
		method: init.method,
		headers: {
			'Client-ID': config.TWITCH_CLIENT_ID,
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
		},
		body: init.body,
	})

	if (res.ok) {
		return (await res.json()) as T
	}

	// 401: our token is bad/expired — drop it and retry once with a fresh one.
	if (res.status === 401 && attempt <= MAX_RETRIES) {
		logger.warn('IGDB returned 401; refreshing token and retrying')
		invalidateToken()
		return executeWithRetry<T>(endpoint, init, attempt + 1)
	}

	// 429: we somehow exceeded the rate limit — exponential backoff then retry.
	// This is a safety net; the queue should normally prevent ever seeing this.
	if (res.status === 429 && attempt <= MAX_RETRIES) {
		const backoffMs = 2 ** attempt * 250 // 500ms, 1s, 2s
		logger.warn(`IGDB 429 rate limited; backing off ${backoffMs}ms`)
		await sleep(backoffMs)
		return executeWithRetry<T>(endpoint, init, attempt + 1)
	}

	throw new Error(`IGDB ${endpoint} failed: ${res.status} ${await res.text()}`)
}
