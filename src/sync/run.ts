import { sql } from '../db/client.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { diffLibrary, type Snapshot } from './diff.js'
import type { OwnedGame, PlayProvider } from './provider.js'
import { steam } from './steam.js'

/** Every provider an account can be linked with, by id. */
export const PROVIDERS: Record<string, PlayProvider> = { steam }

export interface LinkedAccountRow {
	id: string
	did: string
	provider: string
	external_id: string
	status: string
	last_error: string | null
	// Timestamps arrive as text or Date depending on the driver's type parsing,
	// so readers go through `new Date()` rather than trusting either.
	last_synced_at: Date | string | null
	baseline_at: Date | string | null
	created_at: Date | string
}

export interface SyncOutcome {
	status: 'ok' | 'private' | 'error'
	/** Plays filed or added to by this sync. */
	detections: number
}

/** Bound on rows per insert, well under Postgres's 65,535 parameters. */
const INSERT_CHUNK = 1000

/**
 * Sync one account: fetch its library, diff it against the last snapshot, file
 * the difference as plays.
 *
 * Never throws for a platform failure. A Steam outage is recorded on the
 * account and retried on the next pass; it is not an error in our service.
 */
export async function syncAccount(
	account: LinkedAccountRow,
	provider: PlayProvider,
	now = new Date(),
): Promise<SyncOutcome> {
	// postgres-js under Deno cannot bind a Date in every position (the bulk
	// insert helper chokes on one), so timestamps go over the wire as ISO text.
	const syncedAt = now.toISOString()
	let library
	try {
		library = await provider.fetchLibrary(account.external_id)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		logger.warn({ accountId: account.id, provider: provider.id, error: message }, 'Sync failed')
		await sql`
			update linked_accounts
			set status = 'error', last_error = ${message}, last_synced_at = ${syncedAt}
			where id = ${account.id}
		`
		return { status: 'error', detections: 0 }
	}

	if (library.kind === 'private') {
		// Keep the snapshot. When the user makes the library public again, the
		// next sync diffs against what we last saw, and the plays in between
		// arrive as one batch rather than being lost.
		await sql`
			update linked_accounts
			set status = 'private', last_error = null, last_synced_at = ${syncedAt}
			where id = ${account.id}
		`
		return { status: 'private', detections: 0 }
	}

	const detections = await sql.begin(async (tx) => {
		const rows = await tx<
			Array<{
				external_game_id: string
				playtime_minutes: number
				last_played_at: Date | string | null
			}>
		>`
			select external_game_id, playtime_minutes, last_played_at
			from play_snapshots
			where account_id = ${account.id}
		`
		const previous = new Map<string, Snapshot>(
			rows.map((r) => [
				r.external_game_id,
				{
					playtimeMinutes: r.playtime_minutes,
					lastPlayedAt: r.last_played_at === null ? null : new Date(r.last_played_at),
				},
			]),
		)

		const found = diffLibrary(account.baseline_at ? previous : null, library.games, now)

		const changed = library.games.filter((g) => isChanged(previous.get(g.externalGameId), g))
		for (let i = 0; i < changed.length; i += INSERT_CHUNK) {
			const chunk = changed.slice(i, i + INSERT_CHUNK).map((g) => ({
				account_id: account.id,
				external_game_id: g.externalGameId,
				playtime_minutes: g.playtimeMinutes,
				last_played_at: g.lastPlayedAt?.toISOString() ?? null,
			}))
			await tx`
				insert into play_snapshots ${tx(chunk)}
				on conflict (account_id, external_game_id) do update
				set playtime_minutes = excluded.playtime_minutes,
				    last_played_at = excluded.last_played_at
			`
		}

		if (found.length > 0) {
			const plays = found.map((d) => ({
				account_id: account.id,
				did: account.did,
				provider: provider.id,
				external_game_id: d.externalGameId,
				external_game_source: provider.externalGameSource,
				external_name: d.name,
				minutes: d.minutes,
				played_on: d.playedOn,
				last_played_at: d.lastPlayedAt.toISOString(),
			}))
			// Same game, same day: add to the existing row. Its status is left
			// alone, so a play the user already logged or dismissed does not come
			// back because they kept playing that evening.
			await tx`
				insert into detected_plays ${tx(plays)}
				on conflict (account_id, external_game_id, played_on) do update
				set minutes = detected_plays.minutes + excluded.minutes,
				    last_played_at = greatest(detected_plays.last_played_at, excluded.last_played_at),
				    external_name = excluded.external_name,
				    updated_at = now()
			`
		}

		await tx`
			update linked_accounts
			set status = 'ok', last_error = null, last_synced_at = ${syncedAt},
			    baseline_at = coalesce(baseline_at, ${syncedAt})
			where id = ${account.id}
		`
		return found.length
	})

	logger.info(
		{
			accountId: account.id,
			provider: provider.id,
			games: library.games.length,
			detections,
			baseline: !account.baseline_at,
		},
		'Account synced',
	)
	return { status: 'ok', detections }
}

function isChanged(before: Snapshot | undefined, game: OwnedGame): boolean {
	if (!before) return true
	return (
		before.playtimeMinutes !== game.playtimeMinutes ||
		before.lastPlayedAt?.getTime() !== game.lastPlayedAt?.getTime()
	)
}

export interface SyncDueResult {
	synced: number
	detections: number
	failed: number
}

/**
 * Sync every account that has gone stale, up to `limit`.
 *
 * Accounts are claimed by bumping `last_synced_at` in the same statement that
 * picks them, with SKIP LOCKED, so the in-process worker and a `cron:sync` run
 * overlapping never poll the same account twice.
 */
export async function syncDue(
	limit = 100,
	providers: Record<string, PlayProvider> = PROVIDERS,
): Promise<SyncDueResult> {
	const staleBefore = new Date(Date.now() - config.PLAY_SYNC_INTERVAL_MINUTES * 60_000)
	const claimed = await sql<LinkedAccountRow[]>`
		with due as (
			select id from linked_accounts
			where last_synced_at is null or last_synced_at < ${staleBefore.toISOString()}
			order by last_synced_at nulls first
			limit ${limit}
			for update skip locked
		)
		update linked_accounts a
		set last_synced_at = now()
		from due
		where a.id = due.id
		returning a.*
	`

	const result: SyncDueResult = { synced: 0, detections: 0, failed: 0 }
	for (const account of claimed) {
		const provider = providers[account.provider]
		if (!provider) {
			logger.warn({ accountId: account.id, provider: account.provider }, 'Unknown provider')
			continue
		}
		const outcome = await syncAccount(account, provider)
		result.synced++
		result.detections += outcome.detections
		if (outcome.status === 'error') result.failed++
	}
	return result
}
