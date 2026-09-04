import { config } from '../config.js'
import { igdbGet } from '../igdb/client.js'
import { logger } from '../logger.js'
import { ENDPOINT_NAMES, type Endpoint } from './endpoints.js'

/**
 * IGDB webhook registration.
 *
 * Dumps guarantee freshness within 24 hours; webhooks close that to seconds.
 * The dump remains the reconciler — a missed delivery self-heals at the next
 * nightly load — so this layer is allowed to fail without anything breaking.
 *
 * Two IGDB behaviours shape the code:
 *
 *   - After FIVE consecutive delivery failures IGDB sets a webhook inactive and
 *     stops sending. Nothing tells us; the data just quietly stops moving. So
 *     we re-register on every boot (a 409 means it already exists) and surface
 *     the active count on /health.
 *   - Registration is per (endpoint, method), so each endpoint needs three.
 */

const METHODS = ['create', 'update', 'delete'] as const
export type WebhookMethod = (typeof METHODS)[number]

export interface IgdbWebhook {
	id: number
	url: string
	category: number
	sub_category: number
	active: boolean
}

const WEBHOOK_PATH = '/webhooks/igdb'

export function webhookUrl(endpoint: Endpoint, method: WebhookMethod): string | null {
	if (!config.PUBLIC_URL) return null
	// The endpoint and operation also arrive as headers, but putting them in the
	// URL makes a misrouted delivery obvious in the access log.
	return `${config.PUBLIC_URL.replace(/\/$/, '')}${WEBHOOK_PATH}?endpoint=${endpoint}&op=${method}`
}

export async function listWebhooks(): Promise<IgdbWebhook[]> {
	return igdbGet<IgdbWebhook[]>('webhooks')
}

export interface EnsureResult {
	registered: number
	alreadyPresent: number
	failed: number
	active: number
	inactive: number
	skipped?: string
}

/**
 * Register every (endpoint, method) webhook, then report what IGDB thinks.
 *
 * Called on boot. Registering something already registered is a 409, which is
 * the normal case and not an error.
 */
export async function ensureWebhooks(): Promise<EnsureResult> {
	const empty: EnsureResult = {
		registered: 0,
		alreadyPresent: 0,
		failed: 0,
		active: 0,
		inactive: 0,
	}

	if (!config.IGDB_WEBHOOKS_ENABLED) {
		return { ...empty, skipped: 'IGDB_WEBHOOKS_ENABLED is false' }
	}
	if (!config.PUBLIC_URL || !config.IGDB_WEBHOOK_SECRET) {
		// Refusing rather than half-configuring: a webhook registered without a
		// secret would accept anything that found the URL.
		logger.error('Webhooks enabled but PUBLIC_URL or IGDB_WEBHOOK_SECRET is missing')
		return { ...empty, skipped: 'PUBLIC_URL or IGDB_WEBHOOK_SECRET is missing' }
	}

	const result = { ...empty }

	for (const endpoint of ENDPOINT_NAMES) {
		for (const method of METHODS) {
			const url = webhookUrl(endpoint, method)
			if (!url) continue
			try {
				const status = await register(endpoint, method, url)
				if (status === 'created') result.registered++
				else result.alreadyPresent++
			} catch (error) {
				result.failed++
				logger.error({ error, endpoint, method }, 'Webhook registration failed')
			}
		}
	}

	try {
		const all = await listWebhooks()
		result.active = all.filter((w) => w.active).length
		result.inactive = all.length - result.active
		if (result.inactive > 0) {
			// Re-registering should have reactivated these. If any are still off,
			// deliveries have been failing and freshness is down to the nightly dump.
			logger.warn({ inactive: result.inactive }, 'IGDB reports inactive webhooks')
		}
	} catch (error) {
		logger.error({ error }, 'Could not list webhooks')
	}

	logger.info(result, 'Webhook registration complete')
	return result
}

async function register(
	endpoint: Endpoint,
	method: WebhookMethod,
	url: string,
): Promise<'created' | 'exists'> {
	const body = new URLSearchParams({
		url,
		method,
		secret: config.IGDB_WEBHOOK_SECRET ?? '',
	})

	const res = await fetch(`https://api.igdb.com/v4/${endpoint}/webhooks/`, {
		method: 'POST',
		headers: {
			'Client-ID': config.TWITCH_CLIENT_ID,
			Authorization: `Bearer ${await accessToken()}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	})

	// 409 is IGDB saying this exact registration already exists.
	if (res.status === 409) return 'exists'
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
	return 'created'
}

// Imported lazily to keep this module's import graph free of the DB, which the
// token store touches.
async function accessToken(): Promise<string> {
	const { getAccessToken } = await import('../igdb/token.js')
	return getAccessToken()
}
