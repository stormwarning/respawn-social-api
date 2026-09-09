/**
 * Load `data/overrides/*.json` into the override tables.
 *
 *   deno task db:overrides
 *
 * Layer 2 of docs/PLAN-igdb-mirror.md: the only place a human writes game data.
 * It lives in git rather than in the database so a fold decision has a diff, an
 * author and a reason, and so a rebuilt database is identical to the old one.
 *
 * The load is a truncate-and-insert, which makes it idempotent and makes
 * deleting an override as simple as deleting a line. It also writes a content
 * hash to `overrides_meta`, which feeds `titles.source_hash` — so editing any
 * file here invalidates every title on the next `derive:all` without anyone
 * having to work out which titles were affected.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sql } from '../db/client.js'
import { logger } from '../logger.js'

const DIR = 'data/overrides'

// `$comment` keys are documentation for whoever edits the file next; the schemas
// below ignore them rather than rejecting them.
const PlatformsFile = z.object({
	aliases: z.array(
		z.object({
			id: z.number().int(),
			displayName: z.string().min(1),
			sortOrder: z.number().int().default(500),
		}),
	),
})

const GenresFile = z.object({
	aliases: z.array(
		z.object({
			id: z.number().int(),
			displayName: z.string().min(1),
		}),
	),
})

const FoldsFile = z.object({
	overrides: z.array(
		z
			.object({
				gameId: z.number().int(),
				action: z.enum(['fold_into', 'keep_separate', 'hide']),
				targetGameId: z.number().int().nullable().default(null),
				// Written by `deno task overrides:crown`, which replaces exactly these
				// on its next run and leaves everything else alone.
				generated: z.literal('crown').optional(),
				note: z.string().min(1),
			})
			.refine((o) => o.action !== 'fold_into' || o.targetGameId !== null, {
				message: 'fold_into requires a targetGameId',
			}),
	),
})

const PatchesFile = z.object({
	patches: z.array(
		z.object({
			gameId: z.number().int(),
			patch: z.record(
				z.enum(['displayName', 'summary', 'developers', 'publishers', 'firstReleaseDate']),
				z.unknown(),
			),
			note: z.string().min(1),
		}),
	),
})

async function readFile(name: string): Promise<unknown> {
	return JSON.parse(await Deno.readTextFile(`${DIR}/${name}`))
}

const platforms = PlatformsFile.parse(await readFile('platforms.json'))
const genres = GenresFile.parse(await readFile('genres.json'))
const folds = FoldsFile.parse(await readFile('folds.json'))
const patches = PatchesFile.parse(await readFile('patches.json'))

/**
 * Canonical JSON: keys sorted, no whitespace. Two files that mean the same
 * thing hash the same however they are formatted.
 */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

// Hash the PARSED overrides, not the file text. This version feeds
// `titles.source_hash`, so anything it covers re-derives all 309k titles on the
// next sweep — reindenting a file or editing a `$comment` should not do that.
const version = createHash('sha256')
	.update(canonical([platforms, genres, folds, patches]))
	.digest('hex')
	.slice(0, 16)

await sql.begin(async (tx) => {
	await tx`truncate platform_aliases, genre_aliases, fold_overrides, title_patches`

	if (platforms.aliases.length > 0) {
		await tx`insert into platform_aliases ${tx(
			platforms.aliases.map((a) => ({
				platform_id: a.id,
				display_name: a.displayName,
				sort_order: a.sortOrder,
			})),
		)}`
	}

	if (genres.aliases.length > 0) {
		await tx`insert into genre_aliases ${tx(
			genres.aliases.map((a) => ({ genre_id: a.id, display_name: a.displayName })),
		)}`
	}

	if (folds.overrides.length > 0) {
		await tx`insert into fold_overrides ${tx(
			folds.overrides.map((o) => ({
				game_id: o.gameId,
				action: o.action,
				target_game_id: o.targetGameId,
				note: o.note,
			})),
		)}`
	}

	if (patches.patches.length > 0) {
		await tx`insert into title_patches ${tx(
			patches.patches.map((p) => ({
				game_id: p.gameId,
				// Derive reads snake_case keys; the file uses camelCase, like the
				// rest of the TypeScript.
				patch: JSON.stringify(toSnakeKeys(p.patch)),
				note: p.note,
			})),
		)}`
	}

	await tx`
		insert into overrides_meta (id, version, loaded_at)
		values ('overrides', ${version}, now())
		on conflict (id) do update set version = excluded.version, loaded_at = now()
	`
})

function toSnakeKeys(patch: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(patch).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]),
	)
}

logger.info(
	{
		version,
		platformAliases: platforms.aliases.length,
		genreAliases: genres.aliases.length,
		foldOverrides: folds.overrides.length,
		titlePatches: patches.patches.length,
	},
	'Overrides loaded',
)
console.log(`\nOverrides version ${version}. Run \`deno task derive:all\` to apply them to titles.`)

await sql.end()
