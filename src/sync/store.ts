import { sql } from '../db/client.js'
import { coverUrl, TITLE_SHAPE_VERSION, type TitleSummary } from '../titles/read.js'
import type { LinkedAccountRow } from './run.js'

/**
 * Reads and writes behind the /sync routes. Every query is scoped by did, so a
 * caller can only see or change rows for the user it names.
 */

export interface LinkedAccount {
	id: string
	provider: string
	externalId: string
	status: string
	lastError: string | null
	lastSyncedAt: string | null
	createdAt: string
}

export function toAccount(row: LinkedAccountRow): LinkedAccount {
	return {
		id: row.id,
		provider: row.provider,
		externalId: row.external_id,
		status: row.status,
		lastError: row.last_error,
		lastSyncedAt: row.last_synced_at === null ? null : new Date(row.last_synced_at).toISOString(),
		createdAt: new Date(row.created_at).toISOString(),
	}
}

export async function listAccounts(did: string): Promise<LinkedAccountRow[]> {
	return await sql<LinkedAccountRow[]>`
		select * from linked_accounts where did = ${did} order by created_at
	`
}

export async function getAccount(id: string): Promise<LinkedAccountRow | undefined> {
	const [row] = await sql<LinkedAccountRow[]>`select * from linked_accounts where id = ${id}`
	return row
}

export type LinkResult =
	| { kind: 'created'; account: LinkedAccountRow }
	| { kind: 'existing'; account: LinkedAccountRow }
	/** Someone else already linked this platform account. */
	| { kind: 'conflict' }

export async function linkAccount(
	did: string,
	provider: string,
	externalId: string,
): Promise<LinkResult> {
	const [created] = await sql<LinkedAccountRow[]>`
		insert into linked_accounts (did, provider, external_id)
		values (${did}, ${provider}, ${externalId})
		on conflict (provider, external_id) do nothing
		returning *
	`
	if (created) return { kind: 'created', account: created }

	const [existing] = await sql<LinkedAccountRow[]>`
		select * from linked_accounts where provider = ${provider} and external_id = ${externalId}
	`
	// Deleted between the two statements; vanishingly rare, and a retry works.
	if (!existing) return { kind: 'conflict' }
	return existing.did === did ? { kind: 'existing', account: existing } : { kind: 'conflict' }
}

/** Unlink, dropping the snapshot and every play noticed on the account. */
export async function unlinkAccount(id: string, did: string): Promise<boolean> {
	const rows = await sql`delete from linked_accounts where id = ${id} and did = ${did} returning id`
	return rows.length > 0
}

export type PlayStatus = 'pending' | 'logged' | 'dismissed'

export interface DetectedPlay {
	id: string
	provider: string
	externalGameId: string
	externalName: string | null
	minutes: number
	playedOn: string
	lastPlayedAt: string
	status: PlayStatus
	logUri: string | null
	/** The title the game belongs to now, or null when IGDB has no match. */
	title: TitleSummary | null
}

/**
 * Below this, a pending play stays out of the inbox. Launching a game to check
 * a patch note is not a session anyone wants to log. The minutes still
 * accumulate on the row, so a short session followed by a real one surfaces.
 */
const MIN_INBOX_MINUTES = 5

const PLAYS_LIMIT = 100

interface PlayRow {
	id: string
	provider: string
	external_game_id: string
	external_name: string | null
	minutes: number
	played_on: string
	last_played_at: Date | string
	status: PlayStatus
	log_uri: string | null
	title_id: string | null
	slug: string | null
	display_name: string | null
	cover_image_id: string | null
	release_year: number | null
	platforms: Array<{ displayName: string }> | null
}

export async function listPlays(did: string, status: PlayStatus): Promise<DetectedPlay[]> {
	// A Steam appid normally maps to one IGDB game, but nothing enforces that;
	// the lateral join takes the most popular live title so a duplicate cannot
	// list the play twice.
	const rows = await sql<PlayRow[]>`
		select p.id, p.provider, p.external_game_id, p.external_name, p.minutes,
		       to_char(p.played_on, 'YYYY-MM-DD') as played_on, p.last_played_at,
		       p.status, p.log_uri,
		       t.id as title_id, t.slug, t.display_name, t.cover_image_id,
		       t.release_year, t.platforms
		from detected_plays p
		left join lateral (
			select t.id, t.slug, t.display_name, t.cover_image_id, t.release_year, t.platforms
			from igdb_external_games e
			join title_members m on m.game_id = e.game
			join titles t on t.id = m.title_id and t.status = 'live'
			where e.external_game_source = p.external_game_source
			  and e.uid = p.external_game_id
			order by t.popularity desc
			limit 1
		) t on true
		where p.did = ${did} and p.status = ${status}
		  and (p.status <> 'pending' or p.minutes >= ${MIN_INBOX_MINUTES})
		order by p.last_played_at desc
		limit ${PLAYS_LIMIT}
	`

	return rows.map((r) => ({
		id: r.id,
		provider: r.provider,
		externalGameId: r.external_game_id,
		externalName: r.external_name,
		minutes: r.minutes,
		playedOn: r.played_on,
		lastPlayedAt: new Date(r.last_played_at).toISOString(),
		status: r.status,
		logUri: r.log_uri,
		title:
			r.title_id === null
				? null
				: {
						v: TITLE_SHAPE_VERSION,
						id: Number(r.title_id),
						slug: r.slug!,
						displayName: r.display_name!,
						coverImageId: r.cover_image_id,
						coverUrl: coverUrl(r.cover_image_id, 't_cover_small_2x'),
						releaseYear: r.release_year,
						platforms: (r.platforms ?? []).map((p) => p.displayName),
					},
	}))
}

/** Mark a play logged or dismissed. False when it is not this user's play. */
export async function resolvePlay(
	id: string,
	did: string,
	status: 'logged' | 'dismissed',
	logUri: string | null,
): Promise<boolean> {
	const rows = await sql`
		update detected_plays
		set status = ${status}, log_uri = ${logUri}, updated_at = now()
		where id = ${id} and did = ${did}
		returning id
	`
	return rows.length > 0
}
