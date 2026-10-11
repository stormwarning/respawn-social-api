import { Hono } from 'hono'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { timingSafeEqual } from '../secret.js'
import type { PlayProvider } from '../sync/provider.js'
import { PROVIDERS, syncAccount } from '../sync/run.js'
import {
	getAccount,
	linkAccount,
	listAccounts,
	listPlays,
	resolvePlay,
	toAccount,
	unlinkAccount,
} from '../sync/store.js'

/**
 * Play sync routes: linked accounts and the plays noticed on them.
 *
 * Unlike /games, these act on one user's data, and they take that user's did
 * on trust. The web server is what checked the user is signed in; these routes
 * only check that the caller IS the web server, by the X-Internal-Secret
 * header. A browser must never be able to reach them, so without a configured
 * secret every request is refused.
 *
 * Built by a factory so tests can supply a secret and a fake Steam.
 */
export function createSyncRoutes(options: {
	secret: string | undefined
	providers?: Record<string, PlayProvider>
}): Hono {
	const { secret, providers = PROVIDERS } = options
	const routes = new Hono()

	routes.use('*', async (c, next) => {
		if (!secret) {
			logger.error('Sync request received but INTERNAL_API_SECRET is not configured')
			return c.json({ error: 'Sync is not configured' }, 503)
		}
		if (!timingSafeEqual(c.req.header('X-Internal-Secret') ?? '', secret)) {
			return c.json({ error: 'Unauthorized' }, 401)
		}
		await next()
	})

	const did = z.string().startsWith('did:').max(2048)
	const id = z.uuid()

	// GET /sync/accounts?did=
	routes.get('/accounts', async (c) => {
		const parsed = did.safeParse(c.req.query('did'))
		if (!parsed.success) return c.json({ error: 'did is required' }, 400)

		const accounts = await listAccounts(parsed.data)
		return c.json({ accounts: accounts.map(toAccount) })
	})

	// POST /sync/accounts { did, provider, externalId }
	//
	// Links the account and runs its baseline sync before answering, so the
	// settings page can say straight away whether the library is visible.
	const linkSchema = z.object({ did, provider: z.string(), externalId: z.string().max(200) })

	routes.post('/accounts', async (c) => {
		const parsed = linkSchema.safeParse(await c.req.json().catch(() => null))
		if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400)

		const { provider: providerId, externalId } = parsed.data
		const provider = providers[providerId]
		if (!provider) return c.json({ error: `Unknown provider '${providerId}'` }, 400)
		if (!provider.isValidExternalId(externalId)) {
			return c.json({ error: `Not a valid ${providerId} account id` }, 400)
		}

		const result = await linkAccount(parsed.data.did, providerId, externalId)
		if (result.kind === 'conflict') {
			return c.json({ error: 'That account is linked to another user' }, 409)
		}
		if (result.kind === 'existing') return c.json({ account: toAccount(result.account) })

		await syncAccount(result.account, provider)
		const account = (await getAccount(result.account.id)) ?? result.account
		return c.json({ account: toAccount(account) }, 201)
	})

	// DELETE /sync/accounts/:id?did=
	routes.delete('/accounts/:id', async (c) => {
		const parsedId = id.safeParse(c.req.param('id'))
		const parsedDid = did.safeParse(c.req.query('did'))
		if (!parsedId.success || !parsedDid.success) return c.json({ error: 'Not found' }, 404)

		const deleted = await unlinkAccount(parsedId.data, parsedDid.data)
		return deleted ? c.body(null, 204) : c.json({ error: 'Not found' }, 404)
	})

	// GET /sync/plays?did=&status=pending
	const playsQuery = z.object({
		did,
		status: z.enum(['pending', 'logged', 'dismissed']).default('pending'),
	})

	routes.get('/plays', async (c) => {
		const parsed = playsQuery.safeParse({
			did: c.req.query('did'),
			status: c.req.query('status') ?? undefined,
		})
		if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400)

		const plays = await listPlays(parsed.data.did, parsed.data.status)
		return c.json({ plays })
	})

	// POST /sync/plays/:id/resolve { did, status: 'logged' | 'dismissed', logUri? }
	const resolveSchema = z.discriminatedUnion('status', [
		z.object({ did, status: z.literal('logged'), logUri: z.string().startsWith('at://') }),
		z.object({ did, status: z.literal('dismissed') }),
	])

	routes.post('/plays/:id/resolve', async (c) => {
		const parsedId = id.safeParse(c.req.param('id'))
		if (!parsedId.success) return c.json({ error: 'Not found' }, 404)
		const parsed = resolveSchema.safeParse(await c.req.json().catch(() => null))
		if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400)

		const body = parsed.data
		const logUri = body.status === 'logged' ? body.logUri : null
		const updated = await resolvePlay(parsedId.data, body.did, body.status, logUri)
		return updated ? c.body(null, 204) : c.json({ error: 'Not found' }, 404)
	})

	return routes
}

export const syncRoutes = createSyncRoutes({ secret: config.INTERNAL_API_SECRET })
