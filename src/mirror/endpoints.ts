/**
 * What we mirror from IGDB's data dumps.
 *
 * This file is the single source of truth for the canonical (`igdb_*`) layer:
 *
 *   - `src/scripts/gen-mirror-schema.ts` turns it into `src/db/schema.mirror.ts`
 *     (which drizzle-kit turns into migrations).
 *   - `src/scripts/load-dumps.ts` turns it into the staging DDL, the `COPY`
 *     column list, and the live-table upsert.
 *   - The loader's schema guard compares it against the `schema` object that
 *     `GET /v4/dumps/{endpoint}` returns, and refuses to load an endpoint whose
 *     shape has drifted.
 *
 * Adding a column: add it here, re-run `deno task db:gen-mirror` and
 * `deno task db:generate`, then re-run the dump load for that endpoint.
 *
 * Columns present in the dump but deliberately absent here are ignored, which
 * is what lets IGDB add columns upstream without breaking us.
 */

/** The column types IGDB's dump `schema` object uses. */
export type DumpType =
	| 'LONG'
	| 'INTEGER'
	| 'DOUBLE'
	| 'STRING'
	| 'TIMESTAMP'
	| 'UUID'
	| 'BOOLEAN'
	| 'LONG[]'
	| 'INTEGER[]'

/**
 * Postgres type for each dump type.
 *
 * Arrays arrive as Postgres array literals (`{6,14,130}`) and timestamps as
 * `YYYY-MM-DD HH:MM:SS`, so `COPY … (FORMAT csv)` parses every one of these
 * natively — there is no JS-side coercion on the dump path.
 */
export const PG_TYPE: Record<DumpType, string> = {
	LONG: 'bigint',
	INTEGER: 'integer',
	DOUBLE: 'double precision',
	STRING: 'text',
	TIMESTAMP: 'timestamptz',
	UUID: 'uuid',
	BOOLEAN: 'boolean',
	'LONG[]': 'bigint[]',
	'INTEGER[]': 'integer[]',
}

interface EndpointSpec {
	/** Dump columns we mirror, in dump-schema order. */
	columns: Record<string, DumpType>
}

/**
 * Deliberate omissions, so the next reader doesn't "fix" them:
 *
 *   - `games.tags` — bit-packed integers duplicating themes/keywords/genres.
 *   - `*.category` — IGDB's deprecated name for `game_type` / `platform_type` /
 *     `type` / `external_game_source` / `date_format`. Empty on every row now.
 *   - `companies.published` / `developed` — we get the same edges, per game,
 *     from `involved_companies`.
 *   - `companies.company_type_histories` — unused.
 *   - `release_dates` entirely. It was mirrored for a year and read by nothing:
 *     a title's date comes from `igdb_games.first_release_date`. 583k rows,
 *     114 MB, and ~4s of every nightly load, for data no code path touched.
 */
export const ENDPOINTS = {
	games: {
		columns: {
			id: 'LONG',
			name: 'STRING',
			slug: 'STRING',
			url: 'STRING',
			created_at: 'TIMESTAMP',
			updated_at: 'TIMESTAMP',
			summary: 'STRING',
			storyline: 'STRING',
			collection: 'LONG',
			franchise: 'LONG',
			franchises: 'LONG[]',
			hypes: 'INTEGER',
			follows: 'INTEGER',
			rating: 'DOUBLE',
			aggregated_rating: 'DOUBLE',
			aggregated_rating_count: 'INTEGER',
			total_rating: 'DOUBLE',
			total_rating_count: 'INTEGER',
			rating_count: 'INTEGER',
			parent_game: 'LONG',
			version_parent: 'LONG',
			version_title: 'STRING',
			similar_games: 'LONG[]',
			game_engines: 'LONG[]',
			player_perspectives: 'LONG[]',
			game_modes: 'LONG[]',
			keywords: 'LONG[]',
			themes: 'LONG[]',
			genres: 'LONG[]',
			expansions: 'LONG[]',
			dlcs: 'LONG[]',
			bundles: 'LONG[]',
			standalone_expansions: 'LONG[]',
			first_release_date: 'TIMESTAMP',
			status: 'INTEGER',
			platforms: 'LONG[]',
			release_dates: 'LONG[]',
			alternative_names: 'LONG[]',
			screenshots: 'LONG[]',
			videos: 'LONG[]',
			cover: 'LONG',
			websites: 'LONG[]',
			external_games: 'LONG[]',
			multiplayer_modes: 'LONG[]',
			involved_companies: 'LONG[]',
			age_ratings: 'LONG[]',
			artworks: 'LONG[]',
			checksum: 'UUID',
			remakes: 'LONG[]',
			remasters: 'LONG[]',
			expanded_games: 'LONG[]',
			ports: 'LONG[]',
			forks: 'LONG[]',
			language_supports: 'LONG[]',
			game_localizations: 'LONG[]',
			collections: 'LONG[]',
			game_status: 'LONG',
			game_type: 'LONG',
		},
	},
	covers: {
		columns: {
			id: 'LONG',
			url: 'STRING',
			image_id: 'STRING',
			width: 'INTEGER',
			height: 'INTEGER',
			alpha_channel: 'BOOLEAN',
			animated: 'BOOLEAN',
			game: 'LONG',
			checksum: 'UUID',
			game_localization: 'LONG',
			image_type: 'LONG',
		},
	},
	platforms: {
		columns: {
			id: 'LONG',
			name: 'STRING',
			slug: 'STRING',
			url: 'STRING',
			created_at: 'TIMESTAMP',
			updated_at: 'TIMESTAMP',
			summary: 'STRING',
			platform_family: 'LONG',
			alternative_name: 'STRING',
			generation: 'INTEGER',
			versions: 'LONG[]',
			abbreviation: 'STRING',
			platform_logo: 'LONG',
			websites: 'LONG[]',
			checksum: 'UUID',
			platform_type: 'LONG',
		},
	},
	genres: {
		columns: {
			id: 'LONG',
			name: 'STRING',
			created_at: 'TIMESTAMP',
			updated_at: 'TIMESTAMP',
			slug: 'STRING',
			url: 'STRING',
			checksum: 'UUID',
		},
	},
	companies: {
		columns: {
			id: 'LONG',
			name: 'STRING',
			created_at: 'TIMESTAMP',
			updated_at: 'TIMESTAMP',
			slug: 'STRING',
			url: 'STRING',
			logo: 'LONG',
			description: 'STRING',
			start_date: 'TIMESTAMP',
			start_date_category: 'INTEGER',
			country: 'INTEGER',
			parent: 'LONG',
			changed_company_id: 'LONG',
			change_date: 'TIMESTAMP',
			change_date_category: 'INTEGER',
			twitter: 'STRING',
			facebook: 'STRING',
			website: 'LONG',
			websites: 'LONG[]',
			checksum: 'UUID',
			status: 'LONG',
			start_date_format: 'LONG',
			change_date_format: 'LONG',
			company_size: 'LONG',
		},
	},
	involved_companies: {
		columns: {
			id: 'LONG',
			created_at: 'TIMESTAMP',
			updated_at: 'TIMESTAMP',
			game: 'LONG',
			company: 'LONG',
			publisher: 'BOOLEAN',
			developer: 'BOOLEAN',
			supporting: 'BOOLEAN',
			porting: 'BOOLEAN',
			checksum: 'UUID',
		},
	},
	websites: {
		columns: {
			id: 'LONG',
			url: 'STRING',
			trusted: 'BOOLEAN',
			game: 'LONG',
			checksum: 'UUID',
			type: 'LONG',
		},
	},
	external_games: {
		columns: {
			id: 'LONG',
			name: 'STRING',
			created_at: 'TIMESTAMP',
			updated_at: 'TIMESTAMP',
			uid: 'STRING',
			year: 'INTEGER',
			url: 'STRING',
			game: 'LONG',
			checksum: 'UUID',
			countries: 'INTEGER[]',
			platform: 'LONG',
			media: 'INTEGER',
			external_game_source: 'LONG',
			game_release_format: 'LONG',
		},
	},
	alternative_names: {
		columns: {
			id: 'LONG',
			name: 'STRING',
			comment: 'STRING',
			game: 'LONG',
			checksum: 'UUID',
		},
	},
} as const satisfies Record<string, EndpointSpec>

export type Endpoint = keyof typeof ENDPOINTS

/** Load order matters: `games` first so child tables can be reasoned about. */
export const ENDPOINT_NAMES = Object.keys(ENDPOINTS) as Endpoint[]

/** `games` → `igdb_games`. */
export function tableName(endpoint: Endpoint): string {
	return `igdb_${endpoint}`
}

/** The unlogged table a dump is COPY'd into before diffing. */
export function stagingTableName(endpoint: Endpoint): string {
	return `igdb_${endpoint}_staging`
}

export function columnsOf(endpoint: Endpoint): Array<[string, DumpType]> {
	return Object.entries(ENDPOINTS[endpoint].columns) as Array<[string, DumpType]>
}

/**
 * Columns this service owns (not from IGDB), added to every canonical table.
 *
 * `deleted_at` is why rows are never hard-deleted: a game that disappears from
 * IGDB still has user records in PDS repos pointing at its id, so we keep the
 * row and tombstone it. See §7.3 of docs/PLAN-igdb-mirror.md.
 */
export const MIRROR_COLUMNS: Record<string, string> = {
	mirror_updated_at: 'timestamptz not null default now()',
	deleted_at: 'timestamptz',
}

/** Extra columns on specific tables. */
export const EXTRA_COLUMNS: Partial<Record<Endpoint, Record<string, string>>> = {
	// Where a deleted game's records should be read instead. Set by the delete
	// heuristic in §7.3; null for everything else.
	games: { redirect_game_id: 'bigint' },
}
