import { assertEquals } from 'jsr:@std/assert'
import { diffLibrary, type Snapshot } from './diff.js'
import type { OwnedGame } from './provider.js'

const NOW = new Date('2026-10-11T20:00:00Z')
const TUESDAY = new Date('2026-10-06T22:30:00Z')

function game(id: string, minutes: number, lastPlayedAt: Date | null = TUESDAY): OwnedGame {
	return { externalGameId: id, name: `Game ${id}`, playtimeMinutes: minutes, lastPlayedAt }
}

function snapshot(entries: Record<string, number>): Map<string, Snapshot> {
	return new Map(
		Object.entries(entries).map(([id, minutes]) => [
			id,
			{ playtimeMinutes: minutes, lastPlayedAt: null },
		]),
	)
}

Deno.test('a first sync is a baseline and reports nothing', () => {
	// Linking a ten-year-old library must not file ten years of plays.
	assertEquals(diffLibrary(null, [game('620', 900), game('570', 12_000)], NOW), [])
})

Deno.test('a playtime increase is a play of the difference', () => {
	const result = diffLibrary(snapshot({ '620': 900 }), [game('620', 945)], NOW)
	assertEquals(result, [
		{
			externalGameId: '620',
			name: 'Game 620',
			minutes: 45,
			lastPlayedAt: TUESDAY,
			playedOn: '2026-10-06',
		},
	])
})

Deno.test('unchanged playtime is not a play', () => {
	assertEquals(diffLibrary(snapshot({ '620': 900 }), [game('620', 900)], NOW), [])
})

Deno.test('a playtime drop is not a play', () => {
	// Refunds and family sharing can take minutes away.
	assertEquals(diffLibrary(snapshot({ '620': 900 }), [game('620', 600)], NOW), [])
})

Deno.test('a game new to the library counts from zero', () => {
	const result = diffLibrary(snapshot({ '620': 900 }), [game('620', 900), game('413150', 30)], NOW)
	assertEquals(
		result.map((d) => [d.externalGameId, d.minutes]),
		[['413150', 30]],
	)
})

Deno.test('a new, unplayed game is not a play', () => {
	assertEquals(diffLibrary(snapshot({}), [game('413150', 0, null)], NOW), [])
})

Deno.test('a missing last-played time falls back to now', () => {
	const [play] = diffLibrary(snapshot({ '620': 0 }), [game('620', 20, null)], NOW)
	assertEquals(play?.lastPlayedAt, NOW)
	assertEquals(play?.playedOn, '2026-10-11')
})
