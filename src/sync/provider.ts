/**
 * A platform we can read playtime from.
 *
 * Every provider reduces to the same thing: the account's library with a
 * running playtime total per game. Turning totals into plays is the diff's job
 * (`diff.ts`), so a provider only has to fetch and translate.
 */

export interface OwnedGame {
	/** The platform's id for the game, e.g. a Steam appid. */
	externalGameId: string
	/** The platform's name for it, for when IGDB has no match. */
	name: string | null
	playtimeMinutes: number
	lastPlayedAt: Date | null
}

export type LibraryResult =
	| { kind: 'ok'; games: OwnedGame[] }
	/** The platform hid the library: a privacy setting the user can change. */
	| { kind: 'private' }

export interface PlayProvider {
	id: string
	/** IGDB's `external_game_source` id for this platform. */
	externalGameSource: number
	/** Is this a well-formed account id for the platform? */
	isValidExternalId(id: string): boolean
	fetchLibrary(externalId: string): Promise<LibraryResult>
}
