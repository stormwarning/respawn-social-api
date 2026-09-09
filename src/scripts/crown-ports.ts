/**
 * Crown the popular port: generate fold overrides for ports that outrank the
 * game they were ported from.
 *
 *   deno task overrides:crown              # rewrite data/overrides/folds.json
 *   deno task overrides:crown -- --dry-run # print what would change
 *
 * IGDB files a localized release as a PORT of the original it was adapted
 * from: Super Mario Bros. 2 is a port of Yume Koujou: Doki-doki Panic,
 * Castlevania III of Akumajou Densetsu, Streets of Rage 3 of Bare Knuckle III.
 * `resolveRoot` climbs port → parent, so every one of those pages is named
 * after the obscure original. Twenty-three titles in the catalogue at the time
 * of writing, almost all Japanese original vs Western release.
 *
 * This script decides the other way — the port with the audience is the title,
 * and the original folds under it as its `original` member — and writes that
 * decision into `folds.json` as ordinary overrides. A generator rather than a
 * live rule on purpose: IGDB's rating counts drift, and a root that flipped
 * because a threshold was crossed overnight would change a title's id under
 * every user record pointing at it. Frozen in git, the decision changes only
 * when someone re-runs this and commits the diff.
 *
 * Entries it writes carry `generated: "crown"`. Re-running replaces exactly
 * those and leaves hand-written overrides alone; a hand-written entry on
 * either side of a pair also removes that pair from consideration.
 */

import { sql } from '../db/client.js'

const FILE = 'data/overrides/folds.json'

/**
 * Popularity as §6.6 of docs/PLAN-igdb-mirror.md defines it, and the bar a
 * port has to clear. Measured on the 2026-09 catalogue: 3,916 differently
 * named ports, 195 more popular than their parent at all, 29 with ≥20
 * popularity, 23 also at ≥3×. The 3× margin is what keeps a pair that is
 * roughly level from flipping back and forth between runs.
 */
const MIN_POPULARITY = 20
const MIN_RATIO = 3

const dryRun = Deno.args.includes('--dry-run')

interface Override {
	gameId: number
	action: 'fold_into' | 'keep_separate' | 'hide'
	targetGameId?: number | null
	generated?: 'crown'
	note: string
}

interface FoldsFile {
	$comment?: string
	overrides: Override[]
}

interface Candidate {
	id: number
	name: string
	popularity: number
	parentId: number
	parentName: string
	parentPopularity: number
}

const rows = await sql<
	Array<{
		id: string
		name: string
		popularity: number
		parent_id: string
		parent_name: string
		parent_popularity: number
	}>
>`
	with scored as (
		select id, name, parent_game, game_type, version_parent, deleted_at,
		       coalesce(total_rating_count, 0) + coalesce(hypes, 0) * 0.5 as popularity
		from igdb_games
	)
	select distinct on (r.id)
	       c.id, c.name, c.popularity::float as popularity,
	       r.id as parent_id, r.name as parent_name, r.popularity::float as parent_popularity
	from scored c
	join scored r on r.id = c.parent_game
	where c.game_type = 11
	  and c.version_parent is null
	  and c.deleted_at is null
	  and c.name is not null
	  -- The parent must itself be a root, so the crown lands on the head of a
	  -- chain rather than somewhere in the middle of one.
	  and r.parent_game is null
	  and r.version_parent is null
	  and r.deleted_at is null
	  and r.name is not null
	  and lower(c.name) <> lower(r.name)
	  and c.popularity >= ${MIN_POPULARITY}
	  and c.popularity >= ${MIN_RATIO} * r.popularity
	order by r.id, c.popularity desc, c.id
`

const file: FoldsFile = JSON.parse(await Deno.readTextFile(FILE))
const manual = file.overrides.filter((o) => o.generated !== 'crown')
const previous = file.overrides.filter((o) => o.generated === 'crown')
const manualIds = new Set(manual.map((o) => o.gameId))

const candidates: Candidate[] = rows.map((r) => ({
	id: Number(r.id),
	name: r.name,
	popularity: r.popularity,
	parentId: Number(r.parent_id),
	parentName: r.parent_name,
	parentPopularity: r.parent_popularity,
}))

const skipped = candidates.filter((c) => manualIds.has(c.id) || manualIds.has(c.parentId))
const winners = candidates.filter((c) => !manualIds.has(c.id) && !manualIds.has(c.parentId))

const today = new Date().toISOString().slice(0, 10)
const generated: Override[] = []
for (const c of winners) {
	const note =
		`crown: ${c.name} (${c.popularity}) outranks parent ${c.parentName} ` +
		`(${c.parentPopularity}), evaluated ${today}`
	generated.push({
		gameId: c.id,
		action: 'keep_separate',
		targetGameId: null,
		generated: 'crown',
		note,
	})
	generated.push({
		gameId: c.parentId,
		action: 'fold_into',
		targetGameId: c.id,
		generated: 'crown',
		note,
	})
}

// Compare on what matters, not on the note: re-running on unchanged data must
// be a no-op even though the date in the note moves.
const key = (o: Override) => `${o.gameId}:${o.action}:${o.targetGameId ?? ''}`
const before = new Set(previous.map(key))
const after = new Set(generated.map(key))
const added = generated.filter((o) => !before.has(key(o)))
const removed = previous.filter((o) => !after.has(key(o)))

console.log(
	`${'port'.padEnd(44)} ${'pop'.padStart(6)}   ${'original'.padEnd(44)} ${'pop'.padStart(6)}`,
)
for (const c of winners) {
	console.log(
		`${c.name.slice(0, 44).padEnd(44)} ${String(c.popularity).padStart(6)}   ` +
			`${c.parentName.slice(0, 44).padEnd(44)} ${String(c.parentPopularity).padStart(6)}`,
	)
}
console.log('')
console.log(`crowned   ${winners.length}`)
console.log(`skipped   ${skipped.length} (a hand-written override covers one side)`)
for (const c of skipped) console.log(`  ${c.name} / ${c.parentName}`)
console.log(`added     ${added.length} entries`)
console.log(`removed   ${removed.length} entries`)
for (const o of removed) console.log(`  ${o.gameId} ${o.action} ${o.note}`)

if (added.length === 0 && removed.length === 0) {
	console.log('\nNo change.')
} else if (dryRun) {
	console.log('\nDry run: nothing written.')
} else {
	// Unchanged pairs keep their existing note, so a re-run that changes one
	// pair does not re-date every other one.
	const keep = new Map(previous.map((o) => [key(o), o]))
	const merged = generated.map((o) => keep.get(key(o)) ?? o)
	const out: FoldsFile = { ...file, overrides: [...manual, ...merged] }
	await Deno.writeTextFile(FILE, `${JSON.stringify(out, null, '\t')}\n`)
	console.log(`\nWrote ${FILE}. Run \`deno task db:overrides\` then \`deno task derive:all\`.`)
}

await sql.end()
