import sharp from 'sharp'
import { sql } from '../db/client.js'
import { logger } from '../logger.js'

/**
 * Cover colours — §6.8 of docs/PLAN-igdb-mirror.md.
 *
 * This used to run in the web app: the first time anyone marked a game played,
 * the request fetched the cover and ran `sharp` before it could finish. That
 * put an image decode on a user's click, made the same computation happen once
 * per user per game, and pinned a native dependency into the SvelteKit build.
 *
 * Now it happens once, here, keyed by IGDB's image id — which is content
 * addressed, so a given id always yields the same colours and the answer is
 * shareable across every user who ever sees that cover.
 */

const IMAGE_BASE = 'https://images.igdb.com/igdb/image/upload'

/** Big enough for stable statistics, small enough to fetch quickly. */
const VARIANT = 't_cover_big'

export interface CoverColors {
	imageId: string
	dominant: string
	palette: Array<{ hex: string; population: number }> | null
}

const toHex = (n: number) =>
	Math.max(0, Math.min(255, Math.round(n)))
		.toString(16)
		.padStart(2, '0')
const rgbToHex = (r: number, g: number, b: number) => `#${toHex(r)}${toHex(g)}${toHex(b)}`

/** IGDB image ids are short alphanumeric slugs; anything else is not one. */
export function isValidImageId(imageId: string): boolean {
	return /^[a-z0-9]{2,32}$/i.test(imageId)
}

/**
 * Fetch a cover and extract its colours.
 *
 * Returns null rather than throwing when the image is missing or unreadable: a
 * cover that 404s is a data gap, not a failure worth propagating into whatever
 * asked. The caller falls back to no colour, which every consumer handles.
 */
export async function extractCoverColors(imageId: string): Promise<CoverColors | null> {
	if (!isValidImageId(imageId)) return null

	let bytes: Uint8Array
	try {
		const res = await fetch(`${IMAGE_BASE}/${VARIANT}/${imageId}.jpg`)
		if (!res.ok) {
			logger.debug({ imageId, status: res.status }, 'Cover image not available')
			return null
		}
		bytes = new Uint8Array(await res.arrayBuffer())
	} catch (error) {
		logger.warn({ error, imageId }, 'Cover image fetch failed')
		return null
	}

	try {
		const image = sharp(bytes)
		const { dominant } = await image.stats()

		// A three-swatch palette from a tiny resize. `stats().dominant` is a single
		// colour from a histogram bucket; these are the actual pixels a reader
		// sees, which is what a gradient or a background wants.
		const palette = await samplePalette(image)

		return {
			imageId,
			dominant: rgbToHex(dominant.r, dominant.g, dominant.b),
			palette,
		}
	} catch (error) {
		logger.warn({ error, imageId }, 'Cover image could not be decoded')
		return null
	}
}

/**
 * A small palette of the colours actually present in the cover.
 *
 * Downsample to 8x8, then bucket each pixel into a coarse RGB grid so near
 * identical colours count as one, and report each bucket's mean. Without the
 * bucketing every pixel is its own "colour" and every population is 1, which
 * tells a caller nothing — that was the first version.
 *
 * Deliberately crude. A real quantiser would be better and slower, and this
 * only has to be good enough to tint a page behind a cover.
 */
const PALETTE_GRID = 8
/** Channel values are rounded to this step when grouping. 255/32 ≈ 8 levels. */
const BUCKET = 32

async function samplePalette(image: sharp.Sharp): Promise<CoverColors['palette']> {
	try {
		const { data, info } = await image
			.clone()
			.resize(PALETTE_GRID, PALETTE_GRID, { fit: 'cover' })
			.raw()
			.toBuffer({ resolveWithObject: true })

		const buckets = new Map<string, { r: number; g: number; b: number; n: number }>()
		for (let i = 0; i < data.length; i += info.channels) {
			const r = data[i]!
			const g = data[i + 1]!
			const b = data[i + 2]!
			const key = `${Math.round(r / BUCKET)},${Math.round(g / BUCKET)},${Math.round(b / BUCKET)}`
			const bucket = buckets.get(key)
			if (bucket) {
				bucket.r += r
				bucket.g += g
				bucket.b += b
				bucket.n++
			} else {
				buckets.set(key, { r, g, b, n: 1 })
			}
		}

		return [...buckets.values()]
			.sort((a, b) => b.n - a.n)
			.slice(0, 3)
			.map((bucket) => ({
				hex: rgbToHex(bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n),
				population: bucket.n,
			}))
	} catch {
		// The dominant colour is the part anyone actually uses; a failed palette
		// should not lose it.
		return null
	}
}

/** Read stored colours for one image. */
export async function getCoverColors(imageId: string): Promise<CoverColors | null> {
	const [row] = await sql<
		Array<{ image_id: string; dominant: string; palette: CoverColors['palette'] }>
	>`
		select image_id, dominant, palette from cover_colors where image_id = ${imageId}
	`
	return row ? { imageId: row.image_id, dominant: row.dominant, palette: row.palette } : null
}

async function store(colors: CoverColors): Promise<void> {
	await sql`
		insert into cover_colors (image_id, dominant, palette, computed_at)
		values (${colors.imageId}, ${colors.dominant}, ${
			// Stringified, not sql.json(): postgres.js cannot serialize a top-level
			// ARRAY through its json helper and falls back to the string serializer.
			// jsonb parses the text itself, which is what the overrides loader does too.
			colors.palette === null ? null : JSON.stringify(colors.palette)
		}, now())
		on conflict (image_id) do update
			set dominant = excluded.dominant,
			    palette = excluded.palette,
			    computed_at = now()
	`
}

/**
 * Stored colours, computing and saving them on a miss.
 *
 * The lazy path behind `GET /covers/:imageId/colors`, so a cover that arrived
 * since the last backfill still answers rather than 404ing.
 */
export async function ensureCoverColors(imageId: string): Promise<CoverColors | null> {
	const existing = await getCoverColors(imageId)
	if (existing) return existing

	const computed = await extractCoverColors(imageId)
	if (!computed) return null

	await store(computed)
	return computed
}

/**
 * Cover ids on live titles that have no colours yet.
 *
 * A query rather than a queue: the answer is derivable from the two tables at
 * any moment, so there is no state to keep consistent and nothing to lose if
 * the process dies mid-run.
 */
export async function pendingCoverIds(limit: number): Promise<string[]> {
	const rows = await sql<Array<{ cover_image_id: string }>>`
		select distinct t.cover_image_id
		from titles t
		left join cover_colors c on c.image_id = t.cover_image_id
		where t.cover_image_id is not null
		  and t.status = 'live'
		  and c.image_id is null
		order by t.cover_image_id
		limit ${limit}
	`
	return rows.map((r) => r.cover_image_id)
}

export async function pendingCoverCount(): Promise<number> {
	const [row] = await sql<Array<{ n: number }>>`
		select count(distinct t.cover_image_id)::int as n
		from titles t
		left join cover_colors c on c.image_id = t.cover_image_id
		where t.cover_image_id is not null and t.status = 'live' and c.image_id is null
	`
	return row?.n ?? 0
}

export interface BackfillResult {
	attempted: number
	stored: number
	failed: number
}

/**
 * Compute colours for a batch of covers.
 *
 * Bounded concurrency: these are CDN fetches plus a native decode each, and
 * running 300k of them flat out would be rude to IGDB's images host and would
 * starve the connection pool. Failures are counted, not retried — the next run
 * picks them up again because the pending set is a query.
 */
export async function backfillCoverColors(
	imageIds: string[],
	concurrency = 4,
): Promise<BackfillResult> {
	const result: BackfillResult = { attempted: imageIds.length, stored: 0, failed: 0 }
	let cursor = 0

	async function work(): Promise<void> {
		for (;;) {
			const index = cursor++
			if (index >= imageIds.length) return
			const imageId = imageIds[index]!
			try {
				const colors = await extractCoverColors(imageId)
				if (colors) {
					await store(colors)
					result.stored++
				} else {
					result.failed++
				}
			} catch (error) {
				result.failed++
				logger.warn({ error, imageId }, 'Cover colour extraction failed')
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, imageIds.length) }, work))
	return result
}
