import { Hono } from 'hono'
import { sql } from '../db/client.js'
import { config } from '../config.js'
import { markDirtyForIds, notifyDirty } from '../derive/dirty.js'
import { logger } from '../logger.js'
import { ENDPOINT_NAMES, type Endpoint } from '../mirror/endpoints.js'
import { markDeleted, upsertEntity } from '../mirror/upsert.js'

/**
 * IGDB webhook receiver.
 *
 * IGDB posts one unexpanded entity per change — the same shape as a CSV row.
 * A `delete` carries only `{ id }`.
 *
 * The handler does the minimum and returns: mirror the row, queue the affected
 * titles, wake the worker. Deriving inline would put a fold on IGDB's delivery
 * timeout, and IGDB deactivates a webhook after five failures — so a slow
 * handler does not degrade freshness, it ends it.
 */
export const webhooksRoutes = new Hono()

const OPERATIONS = new Set(['create', 'update', 'delete'])

webhooksRoutes.post('/igdb', async (c) => {
	// Verify before reading the body. IGDB publishes no source IP range, so the
	// shared secret plus the user agent is the whole of the authentication.
	const secret = c.req.header('X-Secret')
	const userAgent = c.req.header('User-Agent')

	if (!config.IGDB_WEBHOOK_SECRET) {
		logger.error('Webhook received but IGDB_WEBHOOK_SECRET is not configured')
		return c.text('', 503)
	}
	if (!timingSafeEqual(secret ?? '', config.IGDB_WEBHOOK_SECRET)) {
		logger.warn({ userAgent }, 'Webhook rejected: bad secret')
		return c.text('', 401)
	}
	if (userAgent !== 'IGDB-Webhook-Bot') {
		logger.warn({ userAgent }, 'Webhook rejected: unexpected user agent')
		return c.text('', 401)
	}

	// Headers are authoritative; the query string is a convenience for logs.
	const endpoint = (c.req.header('X-Endpoint') ?? c.req.query('endpoint') ?? '') as Endpoint
	const operation = c.req.header('X-Operation') ?? c.req.query('op') ?? ''

	if (!ENDPOINT_NAMES.includes(endpoint) || !OPERATIONS.has(operation)) {
		// Acknowledge and ignore. Returning an error would count as a delivery
		// failure, and five of those turn the webhook off.
		logger.info({ endpoint, operation }, 'Webhook for an endpoint we do not mirror')
		return c.body(null, 204)
	}

	let body: Record<string, unknown>
	try {
		body = (await c.req.json()) as Record<string, unknown>
	} catch {
		logger.warn({ endpoint, operation }, 'Webhook body was not JSON')
		return c.body(null, 204)
	}

	const entityId = Number(body.id)
	if (!Number.isInteger(entityId) || entityId <= 0) {
		logger.warn({ endpoint, operation }, 'Webhook body had no usable id')
		return c.body(null, 204)
	}

	try {
		// Record the delivery first. The unique constraint makes a resend a no-op,
		// which matters because IGDB gives no delivery guarantee and does resend.
		const inserted = await sql`
			insert into igdb_events (endpoint, op, entity_id, checksum)
			values (${endpoint}, ${operation}, ${entityId}, ${
				(body.checksum as string | undefined) ?? null
			})
			on conflict do nothing
			returning id
		`
		if (inserted.length === 0) {
			logger.debug({ endpoint, operation, entityId }, 'Duplicate webhook delivery ignored')
			return c.body(null, 200)
		}

		let changed: boolean
		if (operation === 'delete') {
			await markDeleted(endpoint, entityId)
			changed = true
		} else {
			changed = (await upsertEntity(endpoint, body)).changed
		}

		if (changed) {
			const queued = await markDirtyForIds(endpoint, [entityId], `webhook:${endpoint}:${operation}`)
			if (queued > 0) await notifyDirty()
			logger.info({ endpoint, operation, entityId, queued }, 'Webhook applied')
		}

		return c.body(null, 200)
	} catch (error) {
		logger.error({ error, endpoint, operation, entityId }, 'Webhook handling failed')
		// A 500 counts as a delivery failure and pushes this webhook towards
		// deactivation, which is right: we genuinely failed, and a retry may work.
		return c.text('', 500)
	}
})

/**
 * Compare without leaking length or position through timing.
 *
 * The secret is low-value and IGDB is not an attacker, but a plain `===` on a
 * credential is the kind of thing that gets copied into somewhere it matters.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}
