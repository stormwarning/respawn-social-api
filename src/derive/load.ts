import { sql } from '../db/client.js'
import { typeset } from './typeset.js'
import type { DeriveInput, DeriveMember, DeriveRefs, MemberGame, PlatformRef } from './index.js'
import type { Membership } from './graph.js'
import type { TitleExternalGame, TitleSimilar, TitleWebsite } from '../db/schema.derived.js'

/**
 * Batch loading for the derive step.
 *
 * Derive itself is pure, so everything it needs has to be fetched first. Doing
 * that one title at a time would mean roughly two million queries for a full
 * sweep. Instead we load a slab of titles at once — one query per child table
 * per batch, regardless of how many titles are in it — and hand `deriveTitle` a
 * fully assembled input.
 *
 * Platforms (220 rows) and genres (23 rows) are loaded once for the whole run.
 */

/** postgres.js returns int8 as a string. Everything here goes through this. */
const num = (value: string | number | null): number | null =>
	value === null ? null : Number(value)

const nums = (value: Array<string | number> | null): number[] =>
	value === null ? [] : value.map(Number)

/**
 * postgres.js hands timestamptz back as a string here, not a Date. Coerce
 * explicitly rather than depend on driver-level parsing — the same reasoning as
 * the int8-to-string coercion above, and the bug that motivated both.
 */
const date = (value: string | Date | null): Date | null => {
	if (value === null) return null
	const parsed = value instanceof Date ? value : new Date(value)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}

export async function loadRefs(): Promise<DeriveRefs> {
	const platformRows = await sql<
		Array<{
			id: string
			name: string | null
			abbreviation: string | null
			display_name: string | null
			sort_order: number | null
		}>
	>`
		select p.id, p.name, p.abbreviation, a.display_name, a.sort_order
		from igdb_platforms p
		left join platform_aliases a on a.platform_id = p.id
		where p.deleted_at is null
	`

	const platforms = new Map<number, PlatformRef>()
	for (const row of platformRows) {
		const name = row.name ?? `Platform ${row.id}`
		platforms.set(Number(row.id), {
			name,
			abbreviation: row.abbreviation,
			// The alias is the whole point of the overrides layer: IGDB calls it
			// "PC (Microsoft Windows)" and we do not have to.
			displayName: row.display_name ?? name,
			sortOrder: row.sort_order ?? 500,
		})
	}

	const genreRows = await sql<
		Array<{ id: string; name: string | null; display_name: string | null }>
	>`
		select g.id, g.name, a.display_name
		from igdb_genres g
		left join genre_aliases a on a.genre_id = g.id
		where g.deleted_at is null
	`

	const genres = new Map<number, { name: string; displayName: string }>()
	for (const row of genreRows) {
		const name = row.name ?? `Genre ${row.id}`
		genres.set(Number(row.id), { name, displayName: row.display_name ?? name })
	}

	return { platforms, genres }
}

export async function loadOverridesVersion(): Promise<string> {
	const rows = await sql<Array<{ version: string }>>`
		select version from overrides_meta where id = 'overrides'
	`
	// No overrides loaded yet is a legitimate state, not an error — it just means
	// every title derives from canonical data alone.
	return rows[0]?.version ?? 'none'
}

interface GameRow {
	id: string
	name: string | null
	slug: string | null
	summary: string | null
	game_type: string | null
	version_title: string | null
	first_release_date: string | Date | null
	platforms: string[] | null
	genres: string[] | null
	similar_games: string[] | null
	cover_image_id: string | null
	total_rating_count: number | null
	hypes: number | null
	checksum: string | null
	deleted_at: string | Date | null
}

const GAME_SELECT = sql`
	select g.id, g.name, g.slug, g.summary, g.game_type, g.version_title,
	       g.first_release_date, g.platforms, g.genres, g.similar_games,
	       c.image_id as cover_image_id,
	       g.total_rating_count, g.hypes, g.checksum, g.deleted_at
	from igdb_games g
	left join igdb_covers c on c.id = g.cover
`

function toMemberGame(row: GameRow): MemberGame {
	return {
		id: Number(row.id),
		name: row.name,
		slug: row.slug,
		summary: row.summary,
		gameType: num(row.game_type),
		versionTitle: row.version_title,
		firstReleaseDate: date(row.first_release_date),
		platformIds: nums(row.platforms),
		genreIds: nums(row.genres),
		coverImageId: row.cover_image_id,
		totalRatingCount: row.total_rating_count,
		hypes: row.hypes,
		checksum: row.checksum,
	}
}

/**
 * Assemble `DeriveInput` for a batch of roots.
 *
 * Nine queries total, whatever the batch size. Callers pass a few hundred roots
 * at a time; the limit is how many ids Postgres wants in one `= any($1)`.
 */
export async function loadInputs(
	rootIds: number[],
	membership: Membership,
	overridesVersion: string,
): Promise<DeriveInput[]> {
	if (rootIds.length === 0) return []

	const memberIds: number[] = []
	for (const rootId of rootIds) {
		for (const member of membership.byRoot.get(rootId) ?? []) memberIds.push(member.gameId)
	}

	const [gameRows, altRows, companyRows, websiteRows, externalRows, patchRows] = await Promise.all([
		sql<GameRow[]>`${GAME_SELECT} where g.id = any(${memberIds})`,
		sql<Array<{ game: string; name: string | null }>>`
			select game, name from igdb_alternative_names
			where game = any(${memberIds}) and deleted_at is null and name is not null
		`,
		// Developers and publishers come from the ROOT only. A port's porting
		// studio is not a developer of the title.
		sql<
			Array<{
				game: string
				name: string | null
				developer: boolean | null
				publisher: boolean | null
			}>
		>`
			select ic.game, c.name, ic.developer, ic.publisher
			from igdb_involved_companies ic
			join igdb_companies c on c.id = ic.company
			where ic.game = any(${rootIds}) and ic.deleted_at is null and c.name is not null
		`,
		sql<Array<{ game: string; url: string | null; type: string | null }>>`
			select game, url, type from igdb_websites
			where game = any(${rootIds}) and deleted_at is null
		`,
		sql<
			Array<{
				game: string
				url: string | null
				uid: string | null
				external_game_source: string | null
			}>
		>`
			select game, url, uid, external_game_source from igdb_external_games
			where game = any(${rootIds}) and deleted_at is null
		`,
		sql<Array<{ game_id: string; patch: Record<string, unknown> }>>`
			select game_id, patch from title_patches where game_id = any(${rootIds})
		`,
	])

	const gameById = new Map<number, GameRow>()
	for (const row of gameRows) gameById.set(Number(row.id), row)

	// Similar games are stored as raw IGDB ids, which may point at a game that
	// folds into some other title. Resolve them through the same membership map
	// so a "similar" link never lands on a page that does not exist. Entries
	// that resolve back to this title are dropped (a game is not similar to
	// itself), and so are ones IGDB has deleted.
	const similarRootIds = new Set<number>()
	for (const rootId of rootIds) {
		for (const id of nums(gameById.get(rootId)?.similar_games ?? null)) {
			const resolved = membership.rootOf.get(id)
			if (resolved !== undefined && resolved !== rootId) similarRootIds.add(resolved)
		}
	}
	const similarRows =
		similarRootIds.size === 0
			? []
			: await sql<GameRow[]>`
		${GAME_SELECT} where g.id = any(${[...similarRootIds]}) and g.deleted_at is null
	`
	const similarById = new Map<number, GameRow>()
	for (const row of similarRows) similarById.set(Number(row.id), row)

	const altsByGame = groupBy(altRows, (r) => Number(r.game))
	const companiesByGame = groupBy(companyRows, (r) => Number(r.game))
	const websitesByGame = groupBy(websiteRows, (r) => Number(r.game))
	const externalByGame = groupBy(externalRows, (r) => Number(r.game))
	const patchByGame = new Map(patchRows.map((r) => [Number(r.game_id), r.patch]))

	const inputs: DeriveInput[] = []
	for (const rootId of rootIds) {
		const rootRow = gameById.get(rootId)
		if (!rootRow) continue

		const members: DeriveMember[] = []
		const alternativeNames: Array<{ gameId: number; name: string }> = []
		for (const { gameId, foldType } of membership.byRoot.get(rootId) ?? []) {
			const row = gameById.get(gameId)
			if (!row) continue
			members.push({ game: toMemberGame(row), foldType })
			for (const alt of altsByGame.get(gameId) ?? []) {
				if (alt.name) alternativeNames.push({ gameId, name: alt.name })
			}
		}
		if (members.length === 0 || members[0]?.foldType !== 'root') continue

		const developers: string[] = []
		const publishers: string[] = []
		for (const row of companiesByGame.get(rootId) ?? []) {
			if (!row.name) continue
			if (row.developer && !developers.includes(row.name)) developers.push(row.name)
			if (row.publisher && !publishers.includes(row.name)) publishers.push(row.name)
		}

		const websites: TitleWebsite[] = (websitesByGame.get(rootId) ?? [])
			.filter((r): r is typeof r & { url: string } => r.url !== null)
			.map((r) => ({ url: r.url, type: num(r.type) }))

		const externalGames: TitleExternalGame[] = (externalByGame.get(rootId) ?? []).map((r) => ({
			url: r.url,
			uid: r.uid,
			source: num(r.external_game_source),
		}))

		const similar: TitleSimilar[] = []
		const seenSimilar = new Set<number>()
		for (const id of nums(rootRow.similar_games)) {
			const resolved = membership.rootOf.get(id)
			if (resolved === undefined || resolved === rootId || seenSimilar.has(resolved)) continue
			const row = similarById.get(resolved)
			if (!row?.name) continue
			seenSimilar.add(resolved)
			similar.push({
				id: resolved,
				slug: row.slug ?? String(resolved),
				displayName: typeset(row.name),
				coverImageId: row.cover_image_id,
			})
		}

		inputs.push({
			rootId,
			members,
			alternativeNames,
			developers,
			publishers,
			websites,
			externalGames,
			similar,
			patch: patchByGame.get(rootId),
			deleted: rootRow.deleted_at !== null,
			overridesVersion,
		})
	}

	return inputs
}

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
	const out = new Map<number, T[]>()
	for (const row of rows) {
		const k = key(row)
		const list = out.get(k)
		if (list) list.push(row)
		else out.set(k, [row])
	}
	return out
}
