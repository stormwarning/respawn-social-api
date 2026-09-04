import { sql } from '../db/client.js'
import type { Endpoint } from '../mirror/endpoints.js'

/**
 * Marking titles for re-derive — §6.5 of docs/PLAN-igdb-mirror.md.
 *
 * All of this is set-based on purpose. A nightly dump changes ~46k games, and
 * resolving those to titles one at a time would be 46k round trips before any
 * work started. Every function here maps ids to titles inside one statement.
 *
 * Which titles a changed row affects depends on the endpoint:
 *
 *   - `games` — the title it belongs to, plus itself when it has no member row
 *     yet (a brand new game IS a new title), plus the titles of its parent and
 *     version parent. That last part matters: when a game's parent changes,
 *     BOTH the old and the new title have to be rebuilt, and the only cheap way
 *     to catch the old one is that it still holds a member row for this id.
 *   - child tables — resolve `game`, then as above.
 *   - `companies` — join through involved_companies. Precise and cheap.
 *   - `platforms` / `genres` — every title renders their names, so mark them
 *     all. That sounds drastic and is not: 220 and 23 rows that change maybe
 *     twice a year, against a sweep that takes about a minute.
 */

/** The endpoints whose rows hang off a game id. */
const GAME_CHILD_TABLES: Partial<Record<Endpoint, string>> = {
	covers: 'igdb_covers',
	involved_companies: 'igdb_involved_companies',
	release_dates: 'igdb_release_dates',
	websites: 'igdb_websites',
	external_games: 'igdb_external_games',
	alternative_names: 'igdb_alternative_names',
}

/**
 * Anything that can run a query: the pool, or a transaction handle.
 *
 * `Pick` rather than a hand-written shape, so postgres.js's own `Sql` and
 * `TransactionSql` both satisfy it — these run inside a transaction on the
 * webhook path and outside one on the dump path.
 */
type Db = Pick<typeof sql, 'unsafe'>

/**
 * Quote a reason for inlining into SQL.
 *
 * These statements build their FROM clause from a table name, so they go
 * through `unsafe`, whose bound-parameter type postgres.js narrows to `never`
 * for an untyped client. The one dynamic value is therefore inlined — and
 * validated first, because inlining into SQL without checking is how injection
 * happens. Reasons are internally generated (`dump:games`,
 * `webhook:covers:update`); anything outside this character set means a caller
 * is doing something unintended, and should fail loudly rather than run.
 */
function reasonLiteral(reason: string): string {
	if (!/^[a-z0-9_:.-]{1,64}$/.test(reason)) {
		throw new Error(`Unexpected dirty reason: ${JSON.stringify(reason)}`)
	}
	return `'${reason}'`
}

/**
 * Mark the titles affected by a set of changed game ids.
 *
 * `source` is a table name or a parenthesised sub-select yielding `id`, which
 * is how the dump loader avoids shipping 46k ids through the client.
 */
async function markFromGameIds(db: Db, source: string, reason: string): Promise<number> {
	const result = await db.unsafe(`
		insert into dirty_titles (title_id, reason)
		select distinct t, ${reasonLiteral(reason)} from (
			-- The title each changed game currently belongs to.
			select m.title_id as t
			from title_members m
			where m.game_id in (select id from ${source})

			union
			-- A game with no member row is new, and is its own title until the
			-- derive says otherwise.
			select g.id
			from igdb_games g
			where g.id in (select id from ${source})
			  and not exists (select 1 from title_members m where m.game_id = g.id)

			union
			-- The titles of its parents, so a game that just moved rebuilds the
			-- title it moved TO as well as the one it left.
			select m.title_id
			from igdb_games g
			join title_members m
			  on m.game_id = g.parent_game or m.game_id = g.version_parent
			where g.id in (select id from ${source})
		) hits
		where t is not null
		on conflict (title_id) do nothing
	`)
	return result.count
}

/** Mark titles affected by changed rows on one endpoint. */
export async function markDirtyForEndpoint(
	db: Db,
	endpoint: Endpoint,
	changedIdsTable: string,
	reason: string,
): Promise<number> {
	if (endpoint === 'games') {
		return markFromGameIds(db, changedIdsTable, reason)
	}

	const childTable = GAME_CHILD_TABLES[endpoint]
	if (childTable) {
		// Resolve the child rows to their games, then reuse the game mapping.
		const games = `(select distinct c.game as id from ${childTable} c
		                where c.id in (select id from ${changedIdsTable}) and c.game is not null)`
		return markFromGameIds(db, games, reason)
	}

	if (endpoint === 'companies') {
		const games = `(select distinct ic.game as id from igdb_involved_companies ic
		                where ic.company in (select id from ${changedIdsTable})
		                  and ic.game is not null)`
		return markFromGameIds(db, games, reason)
	}

	// platforms, genres: every title renders their names.
	const result = await db.unsafe(`
		insert into dirty_titles (title_id, reason)
		select id, ${reasonLiteral(reason)} from titles
		on conflict (title_id) do nothing
	`)
	return result.count
}

/** Mark specific titles dirty. Used by the webhook path and by hand. */
export async function markTitlesDirty(titleIds: number[], reason: string): Promise<number> {
	if (titleIds.length === 0) return 0
	const result = await sql`
		insert into dirty_titles (title_id, reason)
		select unnest(${titleIds}::bigint[]), ${reason}
		on conflict (title_id) do nothing
	`
	return result.count
}

/**
 * Map changed ids on one endpoint to titles, for the webhook path.
 *
 * Same rules as the dump path, but for a handful of ids rather than tens of
 * thousands, so they arrive as a literal array. The temp table exists only so
 * both paths can share one set of queries.
 */
export async function markDirtyForIds(
	endpoint: Endpoint,
	ids: number[],
	reason: string,
): Promise<number> {
	if (ids.length === 0) return 0
	return (await sql.begin(async (tx) => {
		await tx`create temp table changed_ids (id bigint) on commit drop`
		await tx`insert into changed_ids select unnest(${ids}::bigint[])`
		return markDirtyForEndpoint(tx, endpoint, 'changed_ids', reason)
	})) as unknown as number
}

export async function pendingCount(): Promise<number> {
	const [row] = await sql<Array<{ n: number }>>`select count(*)::int as n from dirty_titles`
	return row?.n ?? 0
}

/** Oldest first, so a title never starves behind a busy franchise. */
export async function claimBatch(limit: number): Promise<number[]> {
	const rows = await sql<Array<{ title_id: string }>>`
		select title_id from dirty_titles order by queued_at limit ${limit}
	`
	return rows.map((r) => Number(r.title_id))
}

export async function clearDirty(titleIds: number[]): Promise<void> {
	if (titleIds.length === 0) return
	await sql`delete from dirty_titles where title_id = any(${titleIds})`
}

/** Wake the derive worker. Cheap enough to call on every webhook. */
export async function notifyDirty(): Promise<void> {
	await sql.notify('dirty_titles', '')
}
