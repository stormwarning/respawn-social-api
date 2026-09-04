import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import postgres from 'postgres'
import { config } from '../config.js'
import { webhooksRoutes } from './webhooks.js'

/**
 * The webhook receiver is the only unauthenticated write path in the service,
 * and IGDB's delivery rules make its status codes load-bearing:
 *
 *   - 401 for anything that fails verification.
 *   - 2xx for a delivery we cannot use. Returning an error would count as a
 *     failure, and FIVE failures make IGDB deactivate the webhook — one
 *     malformed payload would otherwise end freshness for that endpoint.
 *   - 5xx only when we genuinely failed and a retry might work.
 */

const app = new Hono().route('/webhooks', webhooksRoutes)
const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} })

const SECRET = config.IGDB_WEBHOOK_SECRET ?? ''
const UA = 'IGDB-Webhook-Bot'

// Well outside IGDB's id range, so a real dump can never collide.
const TEST_GAME = 999_000_222
const TEST_COVER = 999_000_333

function post(
	body: unknown,
	options: { secret?: string; ua?: string; endpoint?: string; op?: string } = {},
): Promise<Response> {
	return Promise.resolve(
		app.request('/webhooks/igdb', {
			method: 'POST',
			headers: {
				'X-Secret': options.secret ?? SECRET,
				'User-Agent': options.ua ?? UA,
				'X-Endpoint': options.endpoint ?? 'games',
				'X-Operation': options.op ?? 'update',
				'Content-Type': 'application/json',
			},
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
	)
}

/**
 * Remove every trace, DERIVED ROWS INCLUDED.
 *
 * These tests write real canonical rows and queue real work, so a derive worker
 * running against the same database (a `deno task dev` in another terminal) can
 * pick them up mid-test and produce a title. Cleaning only the canonical side
 * leaves an orphan title behind — which is exactly what happened the first time.
 */
async function cleanup() {
	await sql`delete from igdb_events where entity_id in (${TEST_GAME}, ${TEST_COVER})`
	await sql`delete from dirty_titles where title_id = ${TEST_GAME}`
	await sql`delete from title_terms where title_id = ${TEST_GAME}`
	await sql`delete from title_members where game_id = ${TEST_GAME} or title_id = ${TEST_GAME}`
	await sql`delete from titles where id = ${TEST_GAME}`
	await sql`delete from igdb_covers where id = ${TEST_COVER}`
	await sql`delete from igdb_games where id = ${TEST_GAME}`
}

Deno.test('rejects a wrong secret', async () => {
	const res = await post({ id: TEST_GAME }, { secret: 'definitely-the-wrong-secret' })
	assertEquals(res.status, 401)
})

Deno.test('rejects a missing secret', async () => {
	const res = await post({ id: TEST_GAME }, { secret: '' })
	assertEquals(res.status, 401)
})

Deno.test('rejects an unexpected user agent', async () => {
	// IGDB publishes no source IP range, so the user agent is half of what we
	// have to go on.
	const res = await post({ id: TEST_GAME }, { ua: 'curl/8.4.0' })
	assertEquals(res.status, 401)
})

Deno.test('acknowledges an endpoint we do not mirror', async () => {
	const res = await post({ id: 1 }, { endpoint: 'artworks' })
	assertEquals(res.status, 204)
})

Deno.test('acknowledges an unknown operation', async () => {
	const res = await post({ id: 1 }, { op: 'frobnicate' })
	assertEquals(res.status, 204)
})

Deno.test('acknowledges a body that is not JSON', async () => {
	const res = await post('not json at all')
	assertEquals(res.status, 204)
})

Deno.test('acknowledges a body with no usable id', async () => {
	assertEquals((await post({ name: 'no id here' })).status, 204)
	assertEquals((await post({ id: 'abc' })).status, 204)
	assertEquals((await post({ id: -1 })).status, 204)
})

Deno.test('a create mirrors the row and records the delivery', async () => {
	await cleanup()

	const res = await post(
		{
			id: TEST_GAME,
			name: 'Webhook Test Game',
			slug: 'webhook-test-game',
			game_type: 0,
			first_release_date: 1431993600,
			checksum: '00000000-0000-0000-0000-0000000000aa',
		},
		{ op: 'create' },
	)
	assertEquals(res.status, 200)

	const [row] = await sql<Array<{ name: string; first_release_date: Date | string }>>`
		select name, first_release_date from igdb_games where id = ${TEST_GAME}
	`
	assertEquals(row?.name, 'Webhook Test Game')
	// Epoch seconds, not milliseconds: the trap that dates everything to 1970.
	assertEquals(new Date(row!.first_release_date).toISOString(), '2015-05-19T00:00:00.000Z')

	const [event] = await sql<Array<{ op: string }>>`
		select op from igdb_events where entity_id = ${TEST_GAME}
	`
	assertEquals(event?.op, 'create')

	await cleanup()
})

Deno.test('a repeated delivery is ignored', async () => {
	await cleanup()

	const body = {
		id: TEST_GAME,
		name: 'Webhook Test Game',
		slug: 'webhook-test-game',
		game_type: 0,
		checksum: '00000000-0000-0000-0000-0000000000bb',
	}
	assertEquals((await post(body)).status, 200)
	assertEquals((await post(body)).status, 200)

	// IGDB gives no delivery guarantee and does resend. The unique constraint on
	// (endpoint, entity, checksum, op) is what makes that a no-op instead of a
	// second round of derive work.
	const [counted] = await sql<Array<{ n: number }>>`
		select count(*)::int as n from igdb_events where entity_id = ${TEST_GAME}
	`
	assertEquals(counted?.n, 1)

	await cleanup()
})

Deno.test('a delete tombstones rather than removing', async () => {
	await cleanup()

	await post(
		{ id: TEST_GAME, name: 'Doomed Game', slug: 'doomed-game', game_type: 0 },
		{ op: 'create' },
	)
	assertEquals((await post({ id: TEST_GAME }, { op: 'delete' })).status, 200)

	// The row stays: PDS records are keyed by IGDB id and still have to render.
	const [row] = await sql<Array<{ name: string; deleted_at: Date | null }>>`
		select name, deleted_at from igdb_games where id = ${TEST_GAME}
	`
	assertEquals(row?.name, 'Doomed Game')
	assertEquals(row?.deleted_at !== null, true)

	await cleanup()
})

Deno.test('an update queues the affected title', async () => {
	await cleanup()

	await post({ id: TEST_GAME, name: 'Queue Me', slug: 'queue-me', game_type: 0 }, { op: 'create' })

	// No member row yet, so the game is its own title and must be queued.
	const [row] = await sql<Array<{ title_id: string; reason: string }>>`
		select title_id, reason from dirty_titles where title_id = ${TEST_GAME}
	`
	assertEquals(Number(row?.title_id), TEST_GAME)
	assertEquals(row?.reason, 'webhook:games:create')

	await cleanup()
})

Deno.test('close the connection', async () => {
	await cleanup()
	await sql.end()
})
