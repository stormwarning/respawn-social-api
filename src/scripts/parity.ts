/**
 * Compare the derived titles against the old read-through cache.
 *
 *   deno task derive:parity
 *   deno task derive:parity -- --show=20   # print this many examples per class
 *
 * The old `games` table holds whatever the live-IGDB pipeline folded, one row
 * per game we ever served. It is the only independent check we have that the
 * new derive produces the same answers, so every class of difference gets
 * looked at before Phase 3 starts serving from `titles`.
 *
 * Differences are EXPECTED in two directions and neither is a failure:
 *   - the old cache is stale (rows were written weeks ago, IGDB has moved on)
 *   - the new fold is deliberately different (version children now fold, and
 *     membership follows parent pointers rather than relation arrays)
 *
 * What matters is that no class of difference is unexplained.
 */

import { sql } from '../db/client.js'

const flags = new Set(Deno.args.filter((a) => a.startsWith('--')))
const showFlag = [...flags].find((f) => f.startsWith('--show='))
const SHOW = showFlag ? Number(showFlag.split('=')[1]) : 5

interface OldPayload {
	id?: number
	name?: string
	platforms?: Array<{ id?: number; name?: string }>
	editions?: string[]
	expansions_normalized?: string[]
	extra_covers?: string[]
	genres?: Array<{ name?: string }>
	involved_companies?: Array<{
		company?: { name?: string }
		developer?: boolean
		publisher?: boolean
	}>
}

const rows = await sql<Array<{ id: string; payload: OldPayload }>>`
	select id, payload from games
`

console.log(`Comparing ${rows.length.toLocaleString()} cached games against derived titles\n`)

const classes = new Map<string, string[]>()
let compared = 0
let notFound = 0
let redirected = 0

function record(kind: string, detail: string) {
	const list = classes.get(kind) ?? []
	list.push(detail)
	classes.set(kind, list)
}

for (const row of rows) {
	const gameId = Number(row.id)
	const payload = row.payload ?? {}

	const [member] = await sql<Array<{ title_id: string; fold_type: string }>>`
		select title_id, fold_type from title_members where game_id = ${gameId}
	`
	if (!member) {
		notFound++
		record('game is no longer part of any title', `${gameId} ${payload.name ?? ''}`)
		continue
	}

	const titleId = Number(member.title_id)
	if (titleId !== gameId) {
		redirected++
		record(
			'cached game now folds into another title',
			`${gameId} ${payload.name ?? ''} -> ${titleId} (${member.fold_type})`,
		)
		continue
	}

	const [title] = await sql<
		Array<{
			name: string
			platforms: Array<{ id: number }>
			editions: string[]
			expansions_normalized: string[]
			extra_cover_image_ids: string[]
			developers: string[]
			publishers: string[]
			genres: Array<{ name: string }>
		}>
	>`
		select name, platforms, editions, expansions_normalized, extra_cover_image_ids,
		       developers, publishers, genres
		from titles where id = ${titleId}
	`
	if (!title) {
		record('member row with no title row', String(titleId))
		continue
	}
	compared++

	const label = `${gameId} ${title.name}`

	compare(
		'platforms',
		label,
		(payload.platforms ?? []).map((p) => String(p.id)),
		title.platforms.map((p) => String(p.id)),
	)
	compare('editions', label, payload.editions ?? [], title.editions)
	compare(
		'expansions_normalized',
		label,
		payload.expansions_normalized ?? [],
		title.expansions_normalized,
	)
	compare(
		'extra covers',
		label,
		(payload.extra_covers ?? []).map(imageIdFromUrl),
		title.extra_cover_image_ids,
	)
	compare(
		'developers',
		label,
		(payload.involved_companies ?? []).filter((c) => c.developer).map((c) => c.company?.name ?? ''),
		title.developers,
	)
	compare(
		'publishers',
		label,
		(payload.involved_companies ?? []).filter((c) => c.publisher).map((c) => c.company?.name ?? ''),
		title.publishers,
	)
	compare(
		'genres',
		label,
		(payload.genres ?? []).map((g) => g.name ?? ''),
		title.genres.map((g) => g.name),
	)
}

function compare(field: string, label: string, before: string[], after: string[]) {
	const a = new Set(before.filter(Boolean))
	const b = new Set(after.filter(Boolean))
	const onlyOld = [...a].filter((v) => !b.has(v))
	const onlyNew = [...b].filter((v) => !a.has(v))
	if (onlyOld.length === 0 && onlyNew.length === 0) return

	const parts: string[] = []
	if (onlyOld.length > 0) parts.push(`only in cache: ${onlyOld.join(', ')}`)
	if (onlyNew.length > 0) parts.push(`only in derived: ${onlyNew.join(', ')}`)
	record(`${field} differ`, `${label} — ${parts.join(' | ')}`)
}

/** ".../t_thumb/co1rs4.jpg" -> "co1rs4" */
function imageIdFromUrl(url: string): string {
	return (
		url
			.split('/')
			.pop()
			?.replace(/\.\w+$/, '') ?? url
	)
}

console.log(`compared      ${compared.toLocaleString()} titles`)
console.log(
	`now folded    ${redirected.toLocaleString()} (cached game is now a member, not a root)`,
)
console.log(`unresolvable  ${notFound.toLocaleString()}\n`)

const sorted = [...classes.entries()].sort((a, b) => b[1].length - a[1].length)
for (const [kind, examples] of sorted) {
	console.log(`${String(examples.length).padStart(6)}  ${kind}`)
	for (const example of examples.slice(0, SHOW)) console.log(`          ${example}`)
}
if (sorted.length === 0) console.log('No differences.')

await sql.end()
