import { sql } from 'drizzle-orm'
import {
	bigint,
	bigserial,
	char,
	check,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'

/**
 * Layers 2 and 3 of docs/PLAN-igdb-mirror.md.
 *
 * Layer 2 (overrides) is the ONLY place a human writes game data. It is small,
 * hand-authored, and loaded from `data/overrides/*.json` — never edited in the
 * database, so it survives a rebuild and lives in git history.
 *
 * Layer 3 (derived) is what the API serves. Every row here is the output of a
 * pure function over layers 1 and 2 and can be thrown away and rebuilt. Nothing
 * ever writes upward: no derive step touches `igdb_*`, and no request path
 * writes to either layer.
 */

// ---------------------------------------------------------------------------
// Layer 2 — overrides
// ---------------------------------------------------------------------------

/** Rename a platform for display: "PC (Microsoft Windows)" -> "Windows". */
export const platformAliases = pgTable('platform_aliases', {
	platformId: bigint('platform_id', { mode: 'number' }).primaryKey(),
	displayName: text('display_name').notNull(),
	// Controls the order platforms appear on a title. Lower sorts first.
	sortOrder: integer('sort_order').notNull().default(0),
})

/** Rename a genre for display: "Role-playing (RPG)" -> "RPG". */
export const genreAliases = pgTable('genre_aliases', {
	genreId: bigint('genre_id', { mode: 'number' }).primaryKey(),
	displayName: text('display_name').notNull(),
})

/**
 * Manual corrections to fold decisions, for the cases IGDB's own metadata gets
 * wrong. `resolveRoot` consults this before anything else.
 */
export const foldOverrides = pgTable(
	'fold_overrides',
	{
		gameId: bigint('game_id', { mode: 'number' }).primaryKey(),
		// fold_into: treat as a member of target_game_id.
		// keep_separate: give it its own title even though IGDB says it folds.
		// hide: do not ingest at all.
		action: text('action').notNull(),
		targetGameId: bigint('target_game_id', { mode: 'number' }),
		// Why. Required by the loader, because a fold decision with no rationale is
		// impossible to review a year later.
		note: text('note').notNull(),
	},
	(t) => [
		check('fold_overrides_action', sql`${t.action} in ('fold_into','keep_separate','hide')`),
		check(
			'fold_overrides_target',
			sql`(${t.action} <> 'fold_into') or (${t.targetGameId} is not null)`,
		),
	],
)

/**
 * Per-title field overrides, for when the deterministic pipeline gets one title
 * wrong. The escape hatch that keeps special cases OUT of typeset() and derive.
 */
export const titlePatches = pgTable('title_patches', {
	gameId: bigint('game_id', { mode: 'number' }).primaryKey(),
	// Allowed keys: display_name, summary, developers, publishers, first_release_date.
	patch: jsonb('patch').$type<Record<string, unknown>>().notNull(),
	note: text('note').notNull(),
})

/**
 * A content hash of the override files, written by the loader.
 *
 * It feeds `titles.source_hash`, so changing any override file invalidates
 * every title on the next sweep without needing to work out which ones changed.
 */
export const overridesMeta = pgTable('overrides_meta', {
	id: text('id').primaryKey(),
	version: text('version').notNull(),
	loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Layer 3 — derived
// ---------------------------------------------------------------------------

export interface TitlePlatform {
	id: number
	name: string
	displayName: string
	abbreviation: string | null
	sortOrder: number
}

export interface TitleGenre {
	id: number
	name: string
	displayName: string
}

export interface TitleSimilar {
	id: number
	slug: string
	displayName: string
	coverImageId: string | null
}

export interface TitleWebsite {
	url: string
	type: number | null
}

export interface TitleExternalGame {
	url: string | null
	uid: string | null
	source: number | null
}

/** One row per title. This is what `/games/*` serves. */
export const titles = pgTable(
	'titles',
	{
		// The root game's IGDB id. Not a surrogate key: user records in PDS repos are
		// keyed by IGDB id, and keeping them aligned is the whole of §7.
		id: bigint('id', { mode: 'number' }).primaryKey(),
		slug: text('slug').notNull(),
		// Raw IGDB text. Never typeset — this is what matching runs against.
		name: text('name').notNull(),
		// Smart punctuation applied. This is what the UI renders.
		displayName: text('display_name').notNull(),
		summary: text('summary'),
		summaryDisplay: text('summary_display'),
		gameType: integer('game_type').notNull(),
		firstReleaseDate: timestamp('first_release_date', { withTimezone: true }),
		releaseYear: integer('release_year'),
		coverImageId: text('cover_image_id'),
		platforms: jsonb('platforms').$type<TitlePlatform[]>().notNull(),
		genres: jsonb('genres').$type<TitleGenre[]>().notNull(),
		developers: text('developers').array().notNull(),
		publishers: text('publishers').array().notNull(),
		// Display forms, typeset. From remasters and version children.
		editions: text('editions').array().notNull(),
		// Display forms, typeset. From DLC and expansions.
		expansionsNormalized: text('expansions_normalized').array().notNull(),
		extraCoverImageIds: text('extra_cover_image_ids').array().notNull(),
		similar: jsonb('similar').$type<TitleSimilar[]>().notNull(),
		websites: jsonb('websites').$type<TitleWebsite[]>().notNull(),
		externalGames: jsonb('external_games').$type<TitleExternalGame[]>().notNull(),
		// Search ranking only. See §6.6.
		popularity: doublePrecision('popularity').notNull().default(0),
		// 'deleted' means IGDB removed the root but we keep serving the last known
		// data, so a user's existing records still render. See §7.3.
		status: text('status').notNull().default('live'),
		// Hash of member checksums + overrides version + DERIVE_VERSION. Lets the
		// worker skip a title whose inputs did not actually change.
		sourceHash: text('source_hash').notNull(),
		deriveVersion: integer('derive_version').notNull(),
		derivedAt: timestamp('derived_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		// Partial on purpose. A tombstoned title keeps its slug so its page still
		// renders, and IGDB reassigns the slug of a deleted duplicate to the survivor
		// — a unique index over ALL titles would then reject the live one at derive
		// time. Uniqueness only has to hold among titles anyone can reach.
		uniqueIndex('titles_slug_live_idx')
			.on(t.slug)
			.where(sql`${t.status} = 'live'`),
		index('titles_slug_idx').on(t.slug),
		index('titles_status_idx').on(t.status),
		index('titles_popularity_idx').on(t.popularity),
		// The browse pages: "most popular, optionally within a year or decade".
		// Partial on status so the long tail of tombstones never enters the scan.
		index('titles_browse_popularity_idx')
			.on(t.popularity.desc())
			.where(sql`${t.status} = 'live'`),
		index('titles_browse_year_idx')
			.on(t.releaseYear, t.popularity.desc())
			.where(sql`${t.status} = 'live'`),
		check('titles_status', sql`${t.status} in ('live','deleted')`),
	],
)

/**
 * Every game that resolves to a title, including the root itself.
 *
 * The primary key on `game_id` is the invariant that makes §7 work: any IGDB id
 * a user record holds maps to exactly one title, so a game folding later is a
 * read-time redirect rather than a rewrite of anyone's repo.
 */
export const titleMembers = pgTable(
	'title_members',
	{
		gameId: bigint('game_id', { mode: 'number' }).primaryKey(),
		titleId: bigint('title_id', { mode: 'number' }).notNull(),
		foldType: text('fold_type').notNull(),
	},
	(t) => [index('title_members_title_id_idx').on(t.titleId)],
)

/**
 * The search index: every string that should find a title.
 *
 * Terms are stored RAW plus normalized. Nothing here is ever typeset — a user
 * typing a straight apostrophe has to match a title carrying a curly one, which
 * is what `normalize()` guarantees on both sides.
 */
export const titleTerms = pgTable(
	'title_terms',
	{
		titleId: bigint('title_id', { mode: 'number' }).notNull(),
		term: text('term').notNull(),
		termNorm: text('term_norm').notNull(),
		// 'root_name' | 'alt_name' | 'member_name' | 'version_title' | 'edition'
		kind: text('kind').notNull(),
		// A = the title's own name, B = alternative names, C = member-derived.
		weight: char('weight', { length: 1 }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.titleId, t.termNorm, t.kind] }),
		index('title_terms_title_id_idx').on(t.titleId),
	],
)

/** Dominant colour per cover image, keyed by IGDB's image id. */
export const coverColors = pgTable('cover_colors', {
	imageId: text('image_id').primaryKey(),
	dominant: text('dominant').notNull(),
	palette: jsonb('palette').$type<Array<{ hex: string; population: number }>>(),
	computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Work queue for the derive worker. */
export const dirtyTitles = pgTable('dirty_titles', {
	titleId: bigint('title_id', { mode: 'number' }).primaryKey(),
	reason: text('reason'),
	queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * An audit log of webhook deliveries.
 *
 * Its real job is idempotency. IGDB gives no delivery guarantee and will resend,
 * so the unique constraint lets a repeat be recognised and dropped rather than
 * re-derived. It is also the only record of what IGDB told us and when, which
 * is the first thing worth looking at when a title is wrong.
 */
export const igdbEvents = pgTable(
	'igdb_events',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		endpoint: text('endpoint').notNull(),
		op: text('op').notNull(),
		entityId: bigint('entity_id', { mode: 'number' }).notNull(),
		checksum: uuid('checksum'),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('igdb_events_delivery').on(t.endpoint, t.entityId, t.checksum, t.op),
		index('igdb_events_received_at_idx').on(t.receivedAt),
	],
)
