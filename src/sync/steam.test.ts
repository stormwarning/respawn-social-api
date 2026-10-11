import { assertEquals } from 'jsr:@std/assert'
import { parseOwnedGames, steam } from './steam.js'

Deno.test('an empty response means the library is private', () => {
	// Steam answers 200 with `{ response: {} }` when "Game details" are hidden.
	assertEquals(parseOwnedGames({ response: {} }), { kind: 'private' })
})

Deno.test('a public, empty library is not private', () => {
	assertEquals(parseOwnedGames({ response: { game_count: 0 } }), { kind: 'ok', games: [] })
})

Deno.test('games translate, and a zero last-played time is null', () => {
	const result = parseOwnedGames({
		response: {
			game_count: 2,
			games: [
				{ appid: 620, name: 'Portal 2', playtime_forever: 900, rtime_last_played: 1_791_000_000 },
				{ appid: 570, name: 'Dota 2', playtime_forever: 0, rtime_last_played: 0 },
			],
		},
	})
	assertEquals(result, {
		kind: 'ok',
		games: [
			{
				externalGameId: '620',
				name: 'Portal 2',
				playtimeMinutes: 900,
				lastPlayedAt: new Date(1_791_000_000_000),
			},
			{ externalGameId: '570', name: 'Dota 2', playtimeMinutes: 0, lastPlayedAt: null },
		],
	})
})

Deno.test('only individual SteamID64s are valid', () => {
	assertEquals(steam.isValidExternalId('76561197960287930'), true)
	assertEquals(steam.isValidExternalId('7656119796028793'), false)
	assertEquals(steam.isValidExternalId('gabelogannewell'), false)
})
