import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import postgres from 'postgres'
import { config } from '../config.js'
import type { OwnedGame, PlayProvider } from '../sync/provider.js'
import { syncAccount } from '../sync/run.js'
import { steam } from '../sync/steam.js'
import { getAccount, type DetectedPlay } from '../sync/store.js'
import { createSyncRoutes } from './sync.js'

/**
 * The sync routes end to end against the real database, with Steam replaced by
 * a library the test controls. Relies on the local mirror knowing Steam appid
 * 620 as Portal 2.
 */

const SECRET = 'test-internal-secret-0123456789'
const DID = 'did:plc:synctestuser000000000000'
const OTHER_DID = 'did:plc:synctestother00000000000'
// Valid SteamID64s, far from any real account.
const STEAM_ID = '76561199999999901'

const PORTAL_2 = '620'
const UNMATCHED = '999999901'

let library: OwnedGame[] = []

const fakeSteam: PlayProvider = {
	...steam,
	fetchLibrary: () => Promise.resolve({ kind: 'ok', games: library }),
}

const app = new Hono().route(
	'/sync',
	createSyncRoutes({ secret: SECRET, providers: { steam: fakeSteam } }),
)
const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

function call(method: string, path: string, body?: unknown, secret = SECRET) {
	return Promise.resolve(
		app.request(`/sync${path}`, {
			method,
			headers: { 'X-Internal-Secret': secret, 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	)
}

function owned(id: string, minutes: number, at = '2026-10-06T22:30:00Z'): OwnedGame {
	return {
		externalGameId: id,
		name: `Steam ${id}`,
		playtimeMinutes: minutes,
		lastPlayedAt: new Date(at),
	}
}

async function pending(did = DID): Promise<DetectedPlay[]> {
	const res = await call('GET', `/plays?did=${encodeURIComponent(did)}`)
	return ((await res.json()) as { plays: DetectedPlay[] }).plays
}

async function cleanup() {
	await sql`delete from linked_accounts where external_id = ${STEAM_ID}`
}

Deno.test('rejects a wrong secret', async () => {
	const res = await call('GET', `/accounts?did=${DID}`, undefined, 'definitely-the-wrong-secret')
	assertEquals(res.status, 401)
})

Deno.test('rejects a missing secret', async () => {
	const res = await call('GET', `/accounts?did=${DID}`, undefined, '')
	assertEquals(res.status, 401)
})

Deno.test('refuses everything when no secret is configured', async () => {
	// Fail closed: an unset env var must not open the routes to anyone.
	const open = new Hono().route('/sync', createSyncRoutes({ secret: undefined }))
	const res = await open.request(`/sync/accounts?did=${DID}`)
	assertEquals(res.status, 503)
})

Deno.test('rejects a malformed Steam id', async () => {
	const res = await call('POST', '/accounts', { did: DID, provider: 'steam', externalId: '12345' })
	assertEquals(res.status, 400)
})

Deno.test({
	name: 'link, baseline, detect, coalesce, resolve, unlink',
	// postgres-js keeps the pool's timers alive between tests.
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await cleanup()
		try {
			// Linking runs the baseline: the existing library is not a play.
			library = [owned(PORTAL_2, 900)]
			const linked = await call('POST', '/accounts', {
				did: DID,
				provider: 'steam',
				externalId: STEAM_ID,
			})
			assertEquals(linked.status, 201)
			const { account } = (await linked.json()) as { account: { id: string; status: string } }
			assertEquals(account.status, 'ok')
			assertEquals(await pending(), [])

			// Linking again is idempotent for the same user, a conflict for another.
			const again = await call('POST', '/accounts', {
				did: DID,
				provider: 'steam',
				externalId: STEAM_ID,
			})
			assertEquals(again.status, 200)
			const stolen = await call('POST', '/accounts', {
				did: OTHER_DID,
				provider: 'steam',
				externalId: STEAM_ID,
			})
			assertEquals(stolen.status, 409)

			// 45 more minutes of Portal 2, a new unmatched game, and a 2-minute
			// launch too short for the inbox.
			library = [owned(PORTAL_2, 945), owned(UNMATCHED, 60), owned('999999902', 2)]
			await syncAccount((await getAccount(account.id))!, fakeSteam)

			let plays = await pending()
			assertEquals(plays.length, 2)
			const portal = plays.find((p) => p.externalGameId === PORTAL_2)!
			assertEquals(portal.minutes, 45)
			assertEquals(portal.playedOn, '2026-10-06')
			assertEquals(portal.title?.slug, 'portal-2')
			assertEquals(plays.find((p) => p.externalGameId === UNMATCHED)?.title, null)

			// More play the same day adds to the same row.
			library = [owned(PORTAL_2, 955, '2026-10-06T23:30:00Z'), owned(UNMATCHED, 60)]
			await syncAccount((await getAccount(account.id))!, fakeSteam)
			plays = await pending()
			assertEquals(plays.find((p) => p.externalGameId === PORTAL_2)?.minutes, 55)

			// Another user cannot see or resolve these.
			assertEquals(await pending(OTHER_DID), [])
			const hijack = await call('POST', `/plays/${portal.id}/resolve`, {
				did: OTHER_DID,
				status: 'dismissed',
			})
			assertEquals(hijack.status, 404)

			const logged = await call('POST', `/plays/${portal.id}/resolve`, {
				did: DID,
				status: 'logged',
				logUri: `at://${DID}/social.respawn.feed.log/3lzz2abcdef22`,
			})
			assertEquals(logged.status, 204)
			assertEquals(
				(await pending()).map((p) => p.externalGameId),
				[UNMATCHED],
			)

			// Unlinking takes the snapshot and the plays with it.
			const unlinked = await call('DELETE', `/accounts/${account.id}?did=${DID}`)
			assertEquals(unlinked.status, 204)
			assertEquals(await pending(), [])
		} finally {
			await cleanup()
			await sql.end()
		}
	},
})
