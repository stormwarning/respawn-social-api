import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from './config.js'
import { logger } from './logger.js'
import { coversRoutes } from './routes/covers.js'
import { gamesRoutes } from './routes/games.js'
import { webhooksRoutes } from './routes/webhooks.js'
import { startDeriveWorker, stopDeriveWorker, workerStatus } from './derive/worker.js'
import { schedulerStatus, startDumpScheduler, stopDumpScheduler } from './mirror/scheduler.js'
import { ensureWebhooks } from './mirror/webhooks.js'
import { mirrorHealth } from './titles/read.js'

const app = new Hono()

/** Filled in once `ensureWebhooks()` has run; surfaced on /health. */
let webhookHealth: Awaited<ReturnType<typeof ensureWebhooks>> | { skipped: string } = {
	skipped: 'not yet run',
}

/**
 * CORS (Cross-Origin Resource Sharing).
 *
 * Backend concept: browsers block a page on origin A from reading responses
 * from origin B unless B explicitly opts in. Our front-end (e.g. localhost:5173)
 * and this API (localhost:8000) are different origins, so we must whitelist the
 * front-end here.
 *
 * (Note: this is also exactly why the browser can't call IGDB directly — IGDB
 * does NOT send these headers. So all IGDB traffic is proxied through us.)
 */
app.use(
	'*',
	cors({
		origin: config.ALLOWED_ORIGINS,
	}),
)

/**
 * Health check.
 *
 * Backend concept: hosting platforms (Fly/Railway) ping a lightweight endpoint
 * to know if the container is alive and ready to receive traffic. Keep it cheap
 * and dependency-free.
 */
app.get('/health', async (c) => {
	// Freshness fails quietly by nature: a deactivated webhook or a stalled dump
	// loader breaks nothing visible, the data just stops moving. Everything that
	// would go silently wrong is reported here so it can be alerted on.
	try {
		return c.json({
			status: 'ok',
			uptime: process.uptime(),
			mirror: await mirrorHealth(),
			worker: workerStatus(),
			dumps: schedulerStatus(),
			webhooks: webhookHealth,
		})
	} catch (err) {
		logger.error(err, 'health check could not read the mirror')
		return c.json({ status: 'degraded', uptime: process.uptime() }, 503)
	}
})

// Feature routes.
app.route('/games', gamesRoutes) // Derived titles, served from Postgres
app.route('/covers', coversRoutes) // Cover colours, computed once and shared
app.route('/webhooks', webhooksRoutes) // IGDB change notifications

/**
 * Fallback handlers.
 *
 * Backend concept: always return clean JSON for unknown routes (404) and
 * uncaught errors (500), so the front-end gets a predictable shape instead of
 * an HTML error page or a hung request. We log the real error server-side but
 * don't leak internals to the client.
 */
app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
	logger.error(err, 'Unhandled error')
	return c.json({ error: 'Internal server error' }, 500)
})

/**
 * Deno's built-in HTTP server.
 *
 * Backend concept: `Deno.serve` starts the server natively (no separate adapter
 * needed). It calls `app.fetch` for every incoming request — Hono speaks the web
 * -standard Request/Response interface that Deno provides.
 */
const server = Deno.serve({ port: config.PORT }, app.fetch)

logger.info(`Listening on http://localhost:${config.PORT}`)

/**
 * Background freshness (Phase 4).
 *
 * Started below, after the server is listening, and never awaited: a slow IGDB
 * or a backlog of dirty titles must not delay the port opening, or a deploy
 * health check fails and the platform kills a process that was working fine.
 */
if (config.DERIVE_WORKER_ENABLED) {
	startDeriveWorker().catch((err) => logger.error(err, 'Derive worker failed to start'))
}

startDumpScheduler()

ensureWebhooks()
	.then((result) => {
		webhookHealth = result
	})
	.catch((err) => logger.error(err, 'Webhook registration failed'))

/**
 * Shut down cleanly.
 *
 * The worker holds a LISTEN connection and may be mid-derive; dropping it
 * without notice leaves rows dirty (harmless, the next boot drains them) but
 * also leaks the connection until Postgres times it out.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	Deno.addSignalListener(signal, () => {
		logger.info({ signal }, 'Shutting down')
		stopDumpScheduler()
		void stopDeriveWorker().finally(() => {
			void server.shutdown().finally(() => Deno.exit(0))
		})
	})
}
