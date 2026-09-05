import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { logger } from '../logger.js'
import {
	browseTitles,
	getTitleByGameId,
	getTitleBySlug,
	searchTitles,
	type Title,
} from '../titles/read.js'
import { resolveTitles } from '../titles/resolve.js'

/**
 * Game routes.
 *
 * Thin by design: validate input, call the read layer, shape the response.
 * Every one of these is served entirely from Postgres — the read layer folds
 * nothing and computes nothing, because `derive:all` already did.
 *
 * Paths are unchanged from the IGDB-proxy era so existing clients keep
 * resolving, but the response body is now a `Title` rather than a raw IGDB
 * payload. `title.v` says which shape it is.
 */
export const gamesRoutes = new Hono()

/**
 * A derived title only changes when a dump or webhook moves its inputs, so it
 * is safe to cache hard and revalidate lazily. `source_hash` is a content hash
 * of everything the title was built from, which makes it an honest ETag.
 */
function cacheable(c: Context, title: Title) {
	c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400')
	c.header('ETag', `"${title.sourceHash}"`)
}

// GET /games/search?q=zelda
// Declared before /:id so "search" is not captured as an id.
const searchQuerySchema = z.object({
	q: z.string().min(1, "query 'q' is required").max(100),
	limit: z.coerce.number().int().min(1).max(50).default(20),
})

gamesRoutes.get('/search', async (c) => {
	const parsed = searchQuerySchema.safeParse({
		q: c.req.query('q'),
		limit: c.req.query('limit') ?? undefined,
	})
	if (!parsed.success) {
		return c.json({ error: z.prettifyError(parsed.error) }, 400)
	}

	try {
		const results = await searchTitles(parsed.data.q, parsed.data.limit)
		// Searches are cheap and local now, but the same query from many users in
		// a burst is still worth collapsing at the edge.
		c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=600')
		return c.json({ results })
	} catch (err) {
		logger.error(err, 'search failed')
		return c.json({ error: 'Failed to search games' }, 500)
	}
})

/**
 * GET /games/browse?year=2012&page=2  |  ?decade=2010
 *
 * A page of the catalogue for the browse pages, most popular first. The two
 * date filters are exclusive: a year already sits inside its decade, so asking
 * for both is a mistake worth reporting rather than silently picking one.
 * Declared before /:id so "browse" is not captured as an id.
 */
const browseQuerySchema = z
	.object({
		year: z.coerce.number().int().min(1950).max(2100).optional(),
		decade: z.coerce
			.number()
			.int()
			.min(1950)
			.max(2100)
			.refine((d) => d % 10 === 0, 'decade must be its first year, e.g. 2010')
			.optional(),
		page: z.coerce.number().int().min(1).default(1),
		limit: z.coerce.number().int().min(1).max(100).default(24),
	})
	.refine((q) => q.year === undefined || q.decade === undefined, {
		message: "'year' and 'decade' cannot be combined",
	})

gamesRoutes.get('/browse', async (c) => {
	const parsed = browseQuerySchema.safeParse({
		year: c.req.query('year') ?? undefined,
		decade: c.req.query('decade') ?? undefined,
		page: c.req.query('page') ?? undefined,
		limit: c.req.query('limit') ?? undefined,
	})
	if (!parsed.success) {
		return c.json({ error: z.prettifyError(parsed.error) }, 400)
	}

	try {
		const result = await browseTitles(parsed.data)
		// The catalogue only moves when a dump or webhook lands, so a page can
		// sit at the edge for a while and be revalidated lazily.
		c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400')
		return c.json(result)
	} catch (err) {
		logger.error(err, 'browse failed')
		return c.json({ error: 'Failed to browse games' }, 500)
	}
})

/**
 * GET /games/resolve?ids=1,2,3
 *
 * Where do these saved ids point now? The web app calls this with a page of
 * records at a time — a profile, a backlog — to group them by the title each
 * one currently belongs to. Batched because one request per record would cost
 * more than rendering the page.
 */
const MAX_RESOLVE_IDS = 200

gamesRoutes.get('/resolve', async (c) => {
	const raw = c.req.query('ids') ?? ''
	const ids = raw
		.split(',')
		.map((part) => Number(part.trim()))
		.filter((id) => Number.isInteger(id) && id > 0)

	if (ids.length === 0) {
		return c.json({ error: "query 'ids' must be a comma-separated list of game ids" }, 400)
	}
	if (ids.length > MAX_RESOLVE_IDS) {
		return c.json({ error: `at most ${MAX_RESOLVE_IDS} ids per request` }, 400)
	}

	try {
		const resolved = await resolveTitles(ids)
		return c.json({ resolved: Object.fromEntries(resolved) })
	} catch (err) {
		logger.error(err, 'resolve failed')
		return c.json({ error: 'Failed to resolve ids' }, 500)
	}
})

// GET /games/slug/:slug
// Declared before /:id so "slug" is not captured as an id.
const slugSchema = z
	.string()
	.min(1)
	.max(120)
	.regex(/^[a-z0-9-]+$/, 'invalid slug')

gamesRoutes.get('/slug/:slug', async (c) => {
	const parsed = slugSchema.safeParse(c.req.param('slug'))
	if (!parsed.success) {
		return c.json({ error: 'invalid slug' }, 400)
	}

	try {
		const title = await getTitleBySlug(parsed.data)
		if (!title) return c.json({ error: 'Game not found' }, 404)
		cacheable(c, title)
		return c.json({ title })
	} catch (err) {
		logger.error(err, `getTitleBySlug(${parsed.data}) failed`)
		return c.json({ error: 'Failed to fetch game' }, 500)
	}
})

// GET /games/:id/members — every IGDB id that resolves to this title.
gamesRoutes.get('/:id/members', async (c) => {
	const id = Number(c.req.param('id'))
	if (!Number.isInteger(id) || id <= 0) {
		return c.json({ error: 'id must be a positive integer' }, 400)
	}

	try {
		const title = await getTitleByGameId(id)
		if (!title) return c.json({ error: 'Game not found' }, 404)
		c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400')
		return c.json({ titleId: title.id, memberIds: title.members })
	} catch (err) {
		logger.error(err, `members(${id}) failed`)
		return c.json({ error: 'Failed to fetch members' }, 500)
	}
})

// GET /games/:id — accepts any IGDB game id, including a folded child's.
gamesRoutes.get('/:id', async (c) => {
	const id = Number(c.req.param('id'))
	if (!Number.isInteger(id) || id <= 0) {
		return c.json({ error: 'id must be a positive integer' }, 400)
	}

	try {
		const title = await getTitleByGameId(id)
		if (!title) return c.json({ error: 'Game not found' }, 404)
		cacheable(c, title)
		return c.json({ title })
	} catch (err) {
		logger.error(err, `getTitleByGameId(${id}) failed`)
		return c.json({ error: 'Failed to fetch game' }, 500)
	}
})
