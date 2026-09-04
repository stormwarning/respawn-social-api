import { sql } from '../db/client.js'
import { typeset } from '../derive/typeset.js'
import { GameType } from '../derive/fold.js'
import type { FoldType } from '../derive/fold.js'

/**
 * How a title relates to its neighbours in IGDB's graph.
 *
 * The fold collapses a franchise into one title, but it does not collapse
 * everything: a remake, a standalone expansion and an "enhanced" re-release all
 * keep their own pages, while DLC, ports and special editions are absorbed.
 * Which side of that line a game falls on is `resolveRoot`'s decision, and both
 * sides need to be visible on a page or the fold looks like data loss.
 *
 * Three things, computed at read time from `title_members` and `igdb_games`:
 *
 *   parent  — "this is a Remake of …", with a link. 4,108 titles have one.
 *   folded  — what was absorbed INTO this title, grouped by how.
 *   related — descendants that kept their own page, so they are reachable.
 *
 * Read-time joins rather than stored columns. They are small indexed lookups
 * against tables the derive already maintains, and `titles` is already carrying
 * ~370 MB of avoidable jsonb (§13.3) without adding more.
 */

const IMAGE_BASE = 'https://images.igdb.com/igdb/image/upload'
const coverUrl = (imageId: string | null, size = 't_cover_big') =>
	imageId === null ? null : `${IMAGE_BASE}/${size}/${imageId}.jpg`

/**
 * What a game of this type IS, relative to its parent.
 *
 * IGDB's own names are internal (`expanded_game`, `standalone_expansion`); these
 * are what a reader should see. Returned alongside the raw `gameType` so a
 * client can relabel without re-deriving the relationship.
 */
const RELATION_LABEL: Record<number, string> = {
	[GameType.DLC_ADDON]: 'DLC',
	[GameType.EXPANSION]: 'Expansion',
	[GameType.STANDALONE_EXPANSION]: 'Expansion',
	[GameType.REMAKE]: 'Remake',
	[GameType.REMASTER]: 'Remaster',
	[GameType.EXPANDED_GAME]: 'Expanded edition',
	[GameType.PORT]: 'Port',
	[GameType.FORK]: 'Fork',
}

export function relationLabel(gameType: number | null): string | null {
	return gameType === null ? null : (RELATION_LABEL[gameType] ?? null)
}

/** How a folded member reads in a list. */
const FOLD_LABEL: Record<FoldType, string> = {
	root: 'Game',
	dlc: 'DLC',
	expansion: 'Expansion',
	remaster: 'Remaster',
	version: 'Edition',
	port: 'Port',
	override: 'Edition',
}

export interface TitleRef {
	id: number
	slug: string
	displayName: string
	coverImageId: string | null
	coverUrl: string | null
	releaseYear: number | null
	/** IGDB's `game_type` for the game this ref describes. */
	gameType: number | null
	/**
	 * What this ref is relative to the title that returned it — "Remake",
	 * "Expansion". Set on `related` entries, which descend from the title. It is
	 * null on `parent`, where the relationship runs the other way and is on
	 * `relationToParent` instead.
	 */
	relation: string | null
}

export interface FoldedMember {
	id: number
	foldType: FoldType
	/** "DLC", "Expansion", "Remaster", "Edition", "Port". */
	label: string
	/** Typeset, in full. An edition shows its version title ("Collector's Edition"). */
	displayName: string
	/**
	 * The same name with the parent title's own name stripped off the front.
	 *
	 * IGDB names DLC in full — "The Witcher 3: Wild Hunt - Blood and Wine" — which
	 * is right in a search result and pure noise in a list on the Witcher 3 page.
	 * Falls back to the full name when there is no shared prefix to remove.
	 */
	shortName: string
	/**
	 * Which member this one hangs off, when that is not the title itself.
	 *
	 * The fold is transitive: World of Warcraft absorbs its expansions, and each
	 * expansion's own Collector's Edition comes up with it. Seven members then
	 * share the name "Collector's Edition" while being seven different products.
	 * This is what tells them apart — "Cataclysm", "Shadowlands" — and it is null
	 * for editions that belong to the base game directly.
	 */
	parentName: string | null
	coverImageId: string | null
	coverUrl: string | null
	releaseYear: number | null
}

export interface TitleRelations {
	/** Every IGDB id that resolves to this title, the root included. */
	memberIds: number[]
	/** The title this one is a remake/expansion/fork OF, if any. */
	parent: TitleRef | null
	/** What THIS title is relative to `parent`: "Remake", "Expansion", … */
	relationToParent: string | null
	/** Absorbed into this title and given no page of their own. */
	folded: FoldedMember[]
	/** Descendants that kept their own page. */
	related: TitleRef[]
}

const year = (date: Date | string | null): number | null =>
	date === null ? null : new Date(date).getUTCFullYear()

const num = (value: string | null): number | null => (value === null ? null : Number(value))

/**
 * Load a title's relations.
 *
 * Three queries, run together. Each is an indexed lookup returning a handful of
 * rows — a title has 1–15 members and rarely more than a few descendants.
 */
export async function loadRelations(titleId: number): Promise<TitleRelations> {
	const [memberRows, parentRows, relatedRows] = await Promise.all([
		sql<
			Array<{
				game_id: string
				fold_type: string
				name: string | null
				version_title: string | null
				image_id: string | null
				first_release_date: Date | string | null
				parent_id: string | null
				parent_name: string | null
			}>
		>`
			select m.game_id, m.fold_type, g.name, g.version_title,
			       c.image_id, g.first_release_date,
			       coalesce(g.version_parent, g.parent_game) as parent_id,
			       coalesce(vp.name, pp.name)                as parent_name
			from title_members m
			join igdb_games g on g.id = m.game_id
			left join igdb_covers c on c.id = g.cover
			left join igdb_games vp on vp.id = g.version_parent
			left join igdb_games pp on pp.id = g.parent_game and g.version_parent is null
			where m.title_id = ${titleId}
			order by g.first_release_date nulls last, m.game_id
		`,

		// The root's parent, resolved to whatever title now serves it.
		// `version_parent` first, matching `resolveRoot`'s own preference.
		sql<
			Array<{
				id: string
				slug: string
				display_name: string
				cover_image_id: string | null
				release_year: number | null
				parent_game_type: string | null
				own_game_type: string | null
			}>
		>`
			select p.id, p.slug, p.display_name, p.cover_image_id, p.release_year,
			       pg.game_type as parent_game_type,
			       g.game_type  as own_game_type
			from igdb_games g
			join title_members m on m.game_id = coalesce(g.version_parent, g.parent_game)
			join titles p on p.id = m.title_id
			join igdb_games pg on pg.id = p.id
			where g.id = ${titleId} and p.id <> ${titleId}
			limit 1
		`,

		// Games descending from ANY member of this title that kept their own
		// page. Anchored on the member set rather than the root alone, so a
		// remake of a folded expansion is still reachable.
		//
		// The two parent columns are tested SEPARATELY rather than through
		// `coalesce(version_parent, parent_game)`. There is no index on that
		// expression, so the coalesce form sequentially scans all 374k games on
		// every page load — 24 ms of the 28 ms this endpoint briefly cost. Written
		// this way each branch is an index scan. The second branch's
		// `version_parent is null` reproduces coalesce's precedence: a game with
		// both set belongs to its version parent.
		sql<
			Array<{
				id: string
				slug: string
				display_name: string
				cover_image_id: string | null
				release_year: number | null
				game_type: string | null
			}>
		>`
			with members as (
				select game_id from title_members where title_id = ${titleId}
			),
			descendants as (
				select id, game_type from igdb_games
				where version_parent in (select game_id from members)
				union
				select id, game_type from igdb_games
				where version_parent is null and parent_game in (select game_id from members)
			)
			select t.id, t.slug, t.display_name, t.cover_image_id, t.release_year,
			       d.game_type
			from descendants d
			join titles t on t.id = d.id
			where t.id <> ${titleId} and t.status = 'live'
			order by t.first_release_date nulls last, t.id
			limit 50
		`,
	])

	const memberIds: number[] = []
	const folded: FoldedMember[] = []
	const rootName = memberRows.find((r) => r.fold_type === 'root')?.name ?? null

	for (const row of memberRows) {
		const id = Number(row.game_id)
		memberIds.push(id)

		const foldType = row.fold_type as FoldType
		if (foldType === 'root') continue

		// An edition's name is its version title ("Slayer Edition"), not its full
		// one ("Warhammer: Chaosbane - Slayer Edition") — the same rule derive
		// uses when it builds `editions`.
		const source = foldType === 'version' ? (row.version_title ?? row.name) : row.name
		const name = source?.trim()
		if (!name) continue

		folded.push({
			id,
			foldType,
			label: FOLD_LABEL[foldType] ?? 'Edition',
			displayName: typeset(name),
			shortName: typeset(stripTitlePrefix(name, rootName)),
			parentName: parentNameOf(row, titleId, rootName),
			coverImageId: row.image_id,
			coverUrl: coverUrl(row.image_id, 't_cover_small_2x'),
			releaseYear: year(row.first_release_date),
		})
	}

	memberIds.sort((a, b) => a - b)

	const parentRow = parentRows[0]

	return {
		memberIds,
		parent: parentRow
			? { ...toRef({ ...parentRow, game_type: parentRow.parent_game_type }), relation: null }
			: null,
		relationToParent: parentRow ? relationLabel(num(parentRow.own_game_type)) : null,
		folded,
		related: relatedRows.map(toRef),
	}
}

/**
 * Drop the parent title's name from the front of a member's name.
 *
 * Only when what remains still says something — "The Witcher 3: Wild Hunt"
 * folded into itself would leave nothing, and a member whose whole name IS the
 * prefix keeps its full name rather than becoming blank.
 */
export function stripTitlePrefix(name: string, titleName: string | null): string {
	if (!titleName) return name
	if (!name.toLowerCase().startsWith(titleName.toLowerCase())) return name

	const rest = name
		.slice(titleName.length)
		.replace(/^[\s:–—\-·|]+/, '')
		.trim()
	return rest.length > 0 ? rest : name
}

/**
 * The name of the member this one belongs to, or null when that is the title.
 *
 * Stripped of the title's own prefix as well, so a World of Warcraft expansion
 * reads as "Cataclysm" rather than "World of Warcraft: Cataclysm" — the title
 * is already the page you are on.
 */
function parentNameOf(
	row: { parent_id: string | null; parent_name: string | null },
	titleId: number,
	rootName: string | null,
): string | null {
	if (row.parent_id === null || row.parent_name === null) return null
	if (Number(row.parent_id) === titleId) return null

	const stripped = stripTitlePrefix(row.parent_name, rootName).trim()
	// If stripping left the parent's whole name, it shares nothing with the
	// title and is likelier to confuse than clarify.
	return stripped.length > 0 && stripped !== row.parent_name ? typeset(stripped) : null
}

function toRef(row: {
	id: string
	slug: string
	display_name: string
	cover_image_id: string | null
	release_year: number | null
	game_type: string | null
}): TitleRef {
	const gameType = row.game_type === null ? null : Number(row.game_type)
	return {
		id: Number(row.id),
		slug: row.slug,
		displayName: row.display_name,
		coverImageId: row.cover_image_id,
		coverUrl: coverUrl(row.cover_image_id, 't_cover_small_2x'),
		releaseYear: row.release_year,
		gameType,
		relation: relationLabel(gameType),
	}
}
