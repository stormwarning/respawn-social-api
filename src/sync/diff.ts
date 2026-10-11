import type { OwnedGame } from './provider.js'

/**
 * Turn two playtime snapshots into plays.
 *
 * Pure on purpose: this is the rule that decides what lands in someone's inbox,
 * and it should be testable without a database or a Steam account.
 */

export interface Snapshot {
	playtimeMinutes: number
	lastPlayedAt: Date | null
}

export interface Detection {
	externalGameId: string
	name: string | null
	/** Minutes played since the previous snapshot. */
	minutes: number
	lastPlayedAt: Date
	/** UTC date of `lastPlayedAt`, YYYY-MM-DD. Plays on the same day coalesce. */
	playedOn: string
}

/**
 * @param previous The last snapshot, or null when the account has never synced.
 *   A first sync is a baseline and reports nothing: everything in the library
 *   was played before the user linked it.
 * @param now Stands in for a missing last-played time.
 */
export function diffLibrary(
	previous: Map<string, Snapshot> | null,
	current: OwnedGame[],
	now: Date,
): Detection[] {
	if (previous === null) return []

	const detections: Detection[] = []
	for (const game of current) {
		// A game new to the library since the last sync counts from zero: bought
		// and played in between.
		const before = previous.get(game.externalGameId)?.playtimeMinutes ?? 0
		const minutes = game.playtimeMinutes - before
		// Playtime can drop (a refund, a family-shared game going away). That is
		// not a play.
		if (minutes <= 0) continue

		const lastPlayedAt = game.lastPlayedAt ?? now
		detections.push({
			externalGameId: game.externalGameId,
			name: game.name,
			minutes,
			lastPlayedAt,
			playedOn: lastPlayedAt.toISOString().slice(0, 10),
		})
	}
	return detections
}
