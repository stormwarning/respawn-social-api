import { assertEquals } from 'jsr:@std/assert@1'
import {
	Category,
	foldRelations,
	type IgdbGame,
	type IgdbRequestFn,
	resolveRootGame,
} from './fold.ts'

/**
 * Fold-layer unit tests. These run with NO live IGDB and NO database: every
 * call goes through a mock `IgdbRequestFn` backed by an in-memory fixture graph,
 * so they're safe to run in CI (`deno task test`).
 */

/** Build a mock request that serves games / version-children from fixtures. */
function mockRequest(
	graph: Record<number, IgdbGame>,
	versionChildren: Record<number, IgdbGame[]> = {},
): { request: IgdbRequestFn; calls: string[] } {
	const calls: string[] = []
	const request: IgdbRequestFn = <T>(_endpoint: string, body: string): Promise<T> => {
		calls.push(body)

		// `where version_parent = N` -> reverse version lookup
		const vp = body.match(/where version_parent = (\d+)/)
		if (vp?.[1]) return Promise.resolve((versionChildren[Number(vp[1])] ?? []) as T)

		// `where id = (a,b,c)` -> batch fetch
		const multi = body.match(/where id = \(([^)]+)\)/)
		if (multi?.[1]) {
			const ids = multi[1].split(',').map((s) => Number(s.trim()))
			return Promise.resolve(ids.map((i) => graph[i]).filter(Boolean) as T)
		}

		// `where id = N` -> single fetch (resolveRootGame walk-up)
		const single = body.match(/where id = (\d+)/)
		if (single?.[1]) {
			const g = graph[Number(single[1])]
			return Promise.resolve((g ? [g] : []) as T)
		}

		return Promise.resolve([] as T)
	}
	return { request, calls }
}

const sorted = (xs?: string[]) => [...(xs ?? [])].sort()
const platformIds = (g: IgdbGame) => (g.platforms ?? []).map((p) => p.id).sort()

Deno.test('foldRelations collapses ports, dlcs, expansions, remasters + versions', async () => {
	const base: IgdbGame = {
		id: 100,
		name: 'Base Game',
		category: Category.MAIN_GAME,
		platforms: [{ id: 1, name: 'PC' }],
		ports: [200],
		dlcs: [300, 700], // 700 is a PACK -> must be skipped
		expansions: [400],
	}
	const graph: Record<number, IgdbGame> = {
		200: {
			id: 200,
			name: 'PS5 Port',
			category: Category.PORT,
			platforms: [{ id: 2, name: 'PS5' }],
		},
		300: {
			id: 300,
			name: 'DLC One',
			category: Category.DLC_ADDON,
			platforms: [{ id: 3, name: 'Xbox' }],
			cover: { url: 'cover-dlc' },
		},
		400: {
			id: 400,
			name: 'Expansion A',
			category: Category.EXPANSION,
			platforms: [{ id: 1, name: 'PC' }], // duplicate platform -> dedup
			cover: { url: 'cover-exp' },
			remasters: [500], // recursion: remaster of an expansion
		},
		500: {
			id: 500,
			name: 'Remaster X',
			category: Category.REMASTER,
			platforms: [{ id: 4, name: 'Switch' }],
			cover: { url: 'cover-rem' },
		},
		700: {
			id: 700,
			name: 'Some Pack',
			category: Category.PACK,
			platforms: [{ id: 9, name: 'Nope' }],
		},
	}
	const versionChildren = {
		100: [
			{ id: 801, version_title: 'GOTY Edition' } as IgdbGame,
			{ id: 802, version_title: 'Deluxe Edition' } as IgdbGame,
		],
	}

	const { request } = mockRequest(graph, versionChildren)
	const folded = await foldRelations(base, request)

	// Platforms merged + deduped by id (PC, PS5, Xbox, Switch). PACK 700's not included.
	assertEquals(platformIds(folded), [1, 2, 3, 4])
	// dlcs + expansions -> expansions_normalized (PACK skipped).
	assertEquals(sorted(folded.expansions_normalized), ['DLC One', 'Expansion A'])
	// remaster (via recursion) + version titles -> editions.
	assertEquals(sorted(folded.editions), ['Deluxe Edition', 'GOTY Edition', 'Remaster X'])
	// covers from dlc, expansion, remaster (not port, not pack).
	assertEquals(sorted(folded.extra_covers), ['cover-dlc', 'cover-exp', 'cover-rem'])
})

Deno.test('foldRelations on a relation-less game just adds empty fold fields', async () => {
	const base: IgdbGame = {
		id: 1,
		name: 'Lonely Game',
		category: Category.MAIN_GAME,
		platforms: [{ id: 1, name: 'PC' }],
	}
	const { request } = mockRequest({})
	const folded = await foldRelations(base, request)

	assertEquals(folded.expansions_normalized, [])
	assertEquals(folded.editions, [])
	assertEquals(folded.extra_covers, [])
	assertEquals(platformIds(folded), [1])
})

Deno.test('resolveRootGame walks a DLC up to its base title', async () => {
	const base: IgdbGame = { id: 100, name: 'Base Game', category: Category.MAIN_GAME }
	const graph: Record<number, IgdbGame> = { 100: base }
	const dlc: IgdbGame = {
		id: 300,
		name: 'DLC One',
		category: Category.DLC_ADDON,
		parent_game: 100,
	}

	const { request } = mockRequest(graph)
	const root = await resolveRootGame(dlc, request)
	assertEquals(root.id, 100)
	assertEquals(root.name, 'Base Game')
})

Deno.test('resolveRootGame prefers version_parent then chains parent_game', async () => {
	// remaster(500) -> version_parent expansion(400) -> parent_game base(100)
	const base: IgdbGame = { id: 100, name: 'Base Game', category: Category.MAIN_GAME }
	const expansion: IgdbGame = {
		id: 400,
		name: 'Expansion A',
		category: Category.EXPANSION,
		parent_game: 100,
	}
	const graph: Record<number, IgdbGame> = { 100: base, 400: expansion }
	const remaster: IgdbGame = {
		id: 500,
		name: 'Remaster X',
		category: Category.REMASTER,
		version_parent: 400,
	}

	const { request } = mockRequest(graph)
	const root = await resolveRootGame(remaster, request)
	assertEquals(root.id, 100)
})

Deno.test('resolveRootGame leaves a "separate" title untouched', async () => {
	const fork: IgdbGame = { id: 50, name: 'A Fork', category: Category.FORK, parent_game: 100 }
	const { request, calls } = mockRequest({ 100: { id: 100, name: 'Base' } })
	const root = await resolveRootGame(fork, request)
	assertEquals(root.id, 50) // forks keep their own row -> no walk-up
	assertEquals(calls.length, 0) // never queried the parent
})

Deno.test('resolveRootGame survives a parent cycle without looping forever', async () => {
	// a(1) -> parent b(2) -> parent a(1)
	const a: IgdbGame = { id: 1, name: 'A', category: Category.DLC_ADDON, parent_game: 2 }
	const b: IgdbGame = { id: 2, name: 'B', category: Category.DLC_ADDON, parent_game: 1 }
	const { request } = mockRequest({ 1: a, 2: b })
	const root = await resolveRootGame(a, request)
	// Walks a->b, then b->a is already seen, so it stops at b. Just assert it returns.
	assertEquals(root.id, 2)
})
