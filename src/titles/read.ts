import { sql } from '../db/client.js'
import type {
	TitleExternalGame,
	TitleGenre,
	TitlePlatform,
	TitleSimilar,
	TitleWebsite,
} from '../db/schema.derived.js'
import { deriveOne } from '../derive/one.js'
import { typeset } from '../derive/typeset.js'
import { igdbRequest } from '../igdb/client.js'
import { logger } from '../logger.js'
import { upsertEntity } from '../mirror/upsert.js'
import { normalize } from '../search/normalize.js'
import { loadRelations, type FoldedMember, type TitleRef } from './relations.js'
import { resolveTitle } from './resolve.js'

/**
 * Reading titles — the entire API read path.
 *
 * Every function here is one or two indexed queries against the derived tables.
 * Nothing folds, nothing calls IGDB, nothing computes: `derive:all` already did
 * all of that. The single exception is `fetchUnknownGame`, for a game IGDB
 * created since our last dump.
 *
 * The row shape and the response shape are deliberately separate, mapped by
 * `toTitle`. `titles` currently denormalizes platforms, genres and similar into
 * jsonb, which costs ~370 MB we may want back (§13.3 of the plan) — keeping the
 * mapping explicit means changing that is a change to this file, not to the
 * API contract or to anything the web app depends on.
 */

/** Bump when the response shape changes, so the web app can assert on it. */
export const TITLE_SHAPE_VERSION = 1

const IMAGE_BASE = 'https://images.igdb.com/igdb/image/upload'

export function coverUrl(imageId: string | null, size = 't_cover_big'): string | null {
	return imageId === null ? null : `${IMAGE_BASE}/${size}/${imageId}.jpg`
}

/** A `similar` entry, with the cover URL the client would otherwise build. */
export interface SimilarTitle extends TitleSimilar {
	coverUrl: string | null
}

export interface Title {
	v: number
	id: number
	slug: string
	name: string
	displayName: string
	summary: string | null
	summaryDisplay: string | null
	gameType: number
	firstReleaseDate: string | null
	releaseYear: number | null
	coverImageId: string | null
	coverUrl: string | null
	/** IGDB's own page for this title. Derived from the slug, not stored. */
	igdbUrl: string
	platforms: TitlePlatform[]
	genres: TitleGenre[]
	developers: string[]
	publishers: string[]
	editions: string[]
	expansionsNormalized: string[]
	extraCoverImageIds: string[]
	similar: SimilarTitle[]
	websites: TitleWebsite[]
	externalGames: TitleExternalGame[]
	status: 'live' | 'deleted'
	sourceHash: string
	/** Every IGDB id that resolves to this title, including its own. */
	members: number[]
	/**
	 * The title this one is a version of — a remake, a standalone expansion, an
	 * enhanced re-release. Null for a base game, which is most of them.
	 */
	parent: TitleRef | null
	/** What this title is relative to `parent`: "Remake", "Expansion", … */
	relationToParent: string | null
	/**
	 * What was folded INTO this title and given no page of its own: DLC,
	 * expansions, remasters, special editions, ports.
	 */
	folded: FoldedMember[]
	/** Descendants that kept their own page, so they stay reachable from here. */
	related: TitleRef[]
	/**
	 * The rest of the series: other titles sharing an IGDB collection with this
	 * one. Siblings rather than descendants — Ocarina of Time and Majora's Mask
	 * are neither a version nor a child of each other. Most popular first, so a
	 * page showing only the first few shows the ones worth showing.
	 */
	collection: TitleRef[]
	/** Set when the request used a child id rather than the title's own. */
	resolvedFrom?: number
}

export interface TitleSummary {
	v: number
	id: number
	slug: string
	displayName: string
	coverImageId: string | null
	coverUrl: string | null
	releaseYear: number | null
	platforms: string[]
}

interface TitleRow {
	id: string
	slug: string
	name: string
	display_name: string
	summary: string | null
	summary_display: string | null
	game_type: number
	first_release_date: Date | string | null
	release_year: number | null
	cover_image_id: string | null
	platforms: TitlePlatform[]
	genres: TitleGenre[]
	developers: string[]
	publishers: string[]
	editions: string[]
	expansions_normalized: string[]
	extra_cover_image_ids: string[]
	similar: TitleSimilar[]
	websites: TitleWebsite[]
	external_games: TitleExternalGame[]
	status: 'live' | 'deleted'
	source_hash: string
}

const TITLE_SELECT = sql`
	select id, slug, name, display_name, summary, summary_display, game_type,
	       first_release_date, release_year, cover_image_id, platforms, genres,
	       developers, publishers, editions, expansions_normalized,
	       -- "similar" is quoted because SIMILAR is a reserved SQL keyword
	       -- (SIMILAR TO); unquoted it is a syntax error, not a column.
	       extra_cover_image_ids, "similar", websites, external_games,
	       status, source_hash
	from titles
`

function toTitle(row: TitleRow, relations: Awaited<ReturnType<typeof loadRelations>>): Title {
	const date = row.first_release_date
	return {
		v: TITLE_SHAPE_VERSION,
		id: Number(row.id),
		slug: row.slug,
		name: row.name,
		displayName: row.display_name,
		summary: row.summary,
		summaryDisplay: row.summary_display,
		gameType: row.game_type,
		firstReleaseDate: date === null ? null : new Date(date).toISOString(),
		releaseYear: row.release_year,
		coverImageId: row.cover_image_id,
		coverUrl: coverUrl(row.cover_image_id),
		igdbUrl: `https://www.igdb.com/games/${row.slug}`,
		platforms: row.platforms,
		genres: row.genres,
		developers: row.developers,
		publishers: row.publishers,
		editions: row.editions,
		expansionsNormalized: row.expansions_normalized,
		extraCoverImageIds: row.extra_cover_image_ids,
		similar: row.similar.map((s) => ({ ...s, coverUrl: coverUrl(s.coverImageId) })),
		websites: row.websites,
		externalGames: row.external_games,
		status: row.status,
		sourceHash: row.source_hash,
		members: relations.memberIds,
		parent: relations.parent,
		relationToParent: relations.relationToParent,
		folded: relations.folded,
		related: relations.related,
		collection: relations.collection,
	}
}

async function loadTitle(titleId: number): Promise<Title | null> {
	const [row] = await sql<TitleRow[]>`${TITLE_SELECT} where id = ${titleId}`
	if (!row) return null
	return toTitle(row, await loadRelations(titleId))
}

/**
 * Fetch a title by any IGDB game id, including a folded child's.
 *
 * A user's PDS record may hold the id of a DLC that has since folded into its
 * parent, so resolution goes through `title_members` rather than assuming the
 * id IS a title. `resolvedFrom` tells the caller it happened, which is what
 * lets the web app canonicalise its URL.
 */
export async function getTitleByGameId(gameId: number): Promise<Title | null> {
	// One definition of "where does this id point now", shared with
	// /games/resolve. Resolving here rather than reading `title_members`
	// directly is what makes a deleted duplicate's id land on its survivor —
	// membership alone would serve the tombstone, and the two endpoints would
	// disagree about the same id.
	const resolved = await resolveTitle(gameId)

	if (resolved.titleId === null) {
		if (resolved.via !== 'unknown') return null
		const derived = await fetchUnknownGame(gameId)
		if (derived === null) return null
		const fetched = await loadTitle(derived)
		if (!fetched) return null
		return derived === gameId ? fetched : { ...fetched, resolvedFrom: gameId }
	}

	const title = await loadTitle(resolved.titleId)
	if (!title) return null
	return resolved.titleId === gameId ? title : { ...title, resolvedFrom: gameId }
}

export async function getTitleBySlug(slug: string): Promise<Title | null> {
	const [row] = await sql<TitleRow[]>`
		${TITLE_SELECT} where slug = ${slug}
		order by (status = 'live') desc, id
		limit 1
	`
	if (!row) return null
	return toTitle(row, await loadRelations(Number(row.id)))
}

/**
 * The only code path that calls IGDB during a request.
 *
 * There is a window between IGDB creating a game and our next dump (or, from
 * Phase 4, the create webhook) landing. Rather than 404 a game that genuinely
 * exists, fetch that one game, mirror it, derive its title, and serve. Returns
 * the title id, or null if IGDB does not have it either.
 */
async function fetchUnknownGame(gameId: number): Promise<number | null> {
	// Already mirrored but not a member of anything: a bundle, a mod, or a
	// tombstone. Nothing to fetch, and no title to serve.
	const [known] = await sql<Array<{ id: string }>>`
		select id from igdb_games where id = ${gameId}
	`
	if (known) return null

	let rows: Array<Record<string, unknown>>
	try {
		rows = await igdbRequest<Array<Record<string, unknown>>>(
			'games',
			`fields *; where id = ${gameId};`,
		)
	} catch (error) {
		logger.error({ error, gameId }, 'Live IGDB lookup failed for an unmirrored game')
		return null
	}

	const game = rows[0]
	if (!game) return null

	await upsertEntity('games', game)
	logger.info({ gameId }, 'Mirrored a game IGDB created since our last dump')

	const { titleId } = await deriveOne(gameId)
	return titleId
}

export interface SearchHit {
	title: TitleSummary
	matchedTerm: string
	kind: string
	score: number
}

/**
 * Search over `title_terms`.
 *
 * Ranking is §8.3 of the plan, rewritten during Phase 2 after the original
 * failed two of its own tuning cases. Two things carry it:
 *
 *   - `word_similarity` blended with `similarity`. The first asks how well the
 *     query matches some contiguous extent of the term, which is what finds
 *     "blood and wine" inside "The Witcher 3: Wild Hunt - Blood and Wine";
 *     alone it over-rewards long titles that merely contain the query, so the
 *     whole-string score pulls it back.
 *   - `ln(1 + popularity)` as a TERM, not a tiebreaker. As a tiebreaker it does
 *     nothing, because scores rarely tie exactly, and "botw" ranks a game
 *     nobody has heard of above Breath of the Wild.
 */
export async function searchTitles(query: string, limit = 20): Promise<SearchHit[]> {
	const q = normalize(query)
	if (q === '') return []

	const rows = await sql<
		Array<{
			id: string
			slug: string
			display_name: string
			cover_image_id: string | null
			release_year: number | null
			platforms: TitlePlatform[]
			term: string
			kind: string
			score: number
		}>
	>`
		with hits as (
			select t.title_id, t.term, t.kind, t.weight,
			       word_similarity(${q}, t.term_norm) as ws,
			       similarity(t.term_norm, ${q})      as sim,
			       (t.term_norm like ${q + '%'})      as prefix
			from title_terms t
			where t.term_norm %> ${q} or t.term_norm like ${q + '%'}
		),
		best as (
			select distinct on (title_id) title_id, term, kind,
			       (case weight when 'A' then 1.0 when 'B' then 0.8 else 0.6 end)
			       * (0.6 * ws + 0.4 * sim + (case when prefix then 0.25 else 0 end))
			       as text_score
			from hits
			order by title_id,
			         (case weight when 'A' then 1.0 when 'B' then 0.8 else 0.6 end)
			         * (0.6 * ws + 0.4 * sim + (case when prefix then 0.25 else 0 end)) desc
		)
		select ti.id, ti.slug, ti.display_name, ti.cover_image_id, ti.release_year,
		       ti.platforms, b.term, b.kind,
		       (b.text_score + 0.06 * ln(1 + ti.popularity))::float8 as score
		from best b
		join titles ti on ti.id = b.title_id
		where ti.status = 'live'
		order by score desc
		limit ${limit}
	`

	return rows.map((row) => ({
		title: {
			v: TITLE_SHAPE_VERSION,
			id: Number(row.id),
			slug: row.slug,
			displayName: row.display_name,
			coverImageId: row.cover_image_id,
			coverUrl: coverUrl(row.cover_image_id, 't_cover_small_2x'),
			releaseYear: row.release_year,
			platforms: row.platforms.map((p) => p.displayName),
		},
		// Typeset here rather than at derive time: `title_terms.term` has to stay
		// exactly what IGDB wrote, because that is what matching runs against.
		// This is the display copy of it.
		matchedTerm: typeset(row.term),
		kind: row.kind,
		score: row.score,
	}))
}

export interface BrowseFilters {
	/** A single release year. */
	year?: number
	/** The first year of a decade: 2010 for the 2010s. */
	decade?: number
	page: number
	limit: number
}

export interface BrowseResult {
	items: TitleSummary[]
	/** Titles matching the filter, across every page. */
	total: number
	page: number
	pageSize: number
}

/**
 * One page of the catalogue, most popular first.
 *
 * The total comes from a window function rather than a second query: the
 * ordered scan over the filtered set happens anyway, and Postgres counts it as
 * it goes. Ties on popularity — most of the long tail sits at zero — break on
 * id so a page boundary never shuffles between requests.
 */
export async function browseTitles(filters: BrowseFilters): Promise<BrowseResult> {
	const { year, decade, page, limit } = filters
	const offset = (page - 1) * limit

	const where =
		year !== undefined
			? sql`and release_year = ${year}`
			: decade !== undefined
				? sql`and release_year between ${decade} and ${decade + 9}`
				: sql``

	const rows = await sql<
		Array<{
			id: string
			slug: string
			display_name: string
			cover_image_id: string | null
			release_year: number | null
			platforms: TitlePlatform[]
			total: string
		}>
	>`
		select id, slug, display_name, cover_image_id, release_year, platforms,
		       count(*) over () as total
		from titles
		where status = 'live' ${where}
		order by popularity desc, id
		limit ${limit} offset ${offset}
	`

	return {
		items: rows.map((row) => ({
			v: TITLE_SHAPE_VERSION,
			id: Number(row.id),
			slug: row.slug,
			displayName: row.display_name,
			coverImageId: row.cover_image_id,
			// The grid renders these as full tiles, unlike search's 72px thumbnails.
			coverUrl: coverUrl(row.cover_image_id),
			releaseYear: row.release_year,
			platforms: row.platforms.map((p) => p.displayName),
		})),
		// A page past the end returns no rows, and with them no window count.
		total: rows[0] ? Number(rows[0].total) : 0,
		page,
		pageSize: limit,
	}
}

export interface MirrorHealth {
	lastDumpAt: string | null
	titles: number
	dirtyCount: number
	/** Live titles whose cover has no colours computed yet. */
	coversPending: number
}

export async function mirrorHealth(): Promise<MirrorHealth> {
	const [row] = await sql<
		Array<{
			last_dump_at: Date | string | null
			titles: number
			dirty: number
			covers_pending: number
		}>
	>`
		select (select max(loaded_at) from dump_runs)   as last_dump_at,
		       (select count(*)::int from titles)       as titles,
		       (select count(*)::int from dirty_titles) as dirty,
		       (select count(distinct t.cover_image_id)::int
		        from titles t
		        left join cover_colors c on c.image_id = t.cover_image_id
		        where t.cover_image_id is not null
		          and t.status = 'live'
		          and c.image_id is null)               as covers_pending
	`
	return {
		lastDumpAt: row?.last_dump_at ? new Date(row.last_dump_at).toISOString() : null,
		titles: row?.titles ?? 0,
		dirtyCount: row?.dirty ?? 0,
		coversPending: row?.covers_pending ?? 0,
	}
}
