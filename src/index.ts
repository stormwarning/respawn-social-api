import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from './config.js'
import { logger } from './logger.js'
import { gamesRoutes } from './routes/games.js'

const app = new Hono()

/**
 * CORS (Cross-Origin Resource Sharing).
 *
 * Backend concept: browsers block a page on origin A from reading responses
 * from origin B unless B explicitly opts in. Our front-end (e.g. localhost:5173)
 * and this API (localhost:3000) are different origins, so we must whitelist the
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
app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }))

// Feature routes.
app.route('/games', gamesRoutes) // IGDB-backed game data (cached)

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
Deno.serve({ port: config.PORT }, app.fetch)

logger.info(`Listening on http://localhost:${config.PORT}`)
