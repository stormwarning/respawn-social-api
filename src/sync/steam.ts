import { config } from '../config.js'
import type { LibraryResult, OwnedGame, PlayProvider } from './provider.js'

/**
 * Steam, through the official Web API.
 *
 * `GetOwnedGames` returns every game in the library with `playtime_forever`
 * (minutes) and `rtime_last_played` (epoch seconds). One request per account
 * per sync, against a key limit of 100,000 a day.
 *
 * A private library is not an error: Steam answers 200 with an empty
 * `response` object. That only happens when the profile's "Game details" are
 * hidden, which the user can fix, so it gets its own status.
 */

const OWNED_GAMES_URL = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/'

/** IGDB's `external_game_source` for Steam. */
const IGDB_SOURCE_STEAM = 1

interface SteamOwnedGame {
	appid: number
	name?: string
	playtime_forever: number
	rtime_last_played?: number
}

interface SteamOwnedGamesResponse {
	response: { game_count?: number; games?: SteamOwnedGame[] }
}

export class SteamError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'SteamError'
	}
}

export const steam: PlayProvider = {
	id: 'steam',
	externalGameSource: IGDB_SOURCE_STEAM,

	// A SteamID64: 17 digits, always starting 7656119 for individual accounts.
	isValidExternalId: (id) => /^7656119\d{10}$/.test(id),

	async fetchLibrary(steamId) {
		if (!config.STEAM_API_KEY) throw new SteamError(0, 'STEAM_API_KEY is not set')

		const params = new URLSearchParams({
			key: config.STEAM_API_KEY,
			steamid: steamId,
			include_appinfo: '1',
			include_played_free_games: '1',
			format: 'json',
		})
		const res = await fetch(`${OWNED_GAMES_URL}?${params}`)
		if (!res.ok) {
			// Never echo the URL: it carries the key.
			throw new SteamError(res.status, `GetOwnedGames -> ${res.status}`)
		}

		const body = (await res.json()) as SteamOwnedGamesResponse
		return parseOwnedGames(body)
	},
}

/** Exported for tests. */
export function parseOwnedGames(body: SteamOwnedGamesResponse): LibraryResult {
	// A public profile with an empty library still reports `game_count: 0`.
	if (body.response.game_count === undefined) return { kind: 'private' }

	const games: OwnedGame[] = (body.response.games ?? []).map((g) => ({
		externalGameId: String(g.appid),
		name: g.name ?? null,
		playtimeMinutes: g.playtime_forever,
		// Zero means "never", not 1970.
		lastPlayedAt: g.rtime_last_played ? new Date(g.rtime_last_played * 1000) : null,
	}))
	return { kind: 'ok', games }
}
