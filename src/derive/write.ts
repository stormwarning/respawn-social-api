import { inArray, sql as drizzleSql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { titleMembers, titles, titleTerms } from '../db/schema.derived.js'
import type { DerivedTitle } from './index.js'

/**
 * Writing derived titles.
 *
 * Through Drizzle rather than raw SQL, because `titles` mixes jsonb, text[] and
 * timestamptz columns and Drizzle already knows how to bind each one. The
 * batching exists for one reason: Postgres caps a statement at 65,535 bound
 * parameters, and `titles` has 25 columns.
 */

const TITLE_CHUNK = 400
const ROW_CHUNK = 2000

export async function writeTitles(derived: DerivedTitle[]): Promise<void> {
	if (derived.length === 0) return

	const titleIds = derived.map((d) => d.id)

	await db.transaction(async (tx) => {
		for (const chunk of chunks(derived, TITLE_CHUNK)) {
			await tx
				.insert(titles)
				.values(
					chunk.map((d) => ({
						id: d.id,
						slug: d.slug,
						name: d.name,
						displayName: d.displayName,
						summary: d.summary,
						summaryDisplay: d.summaryDisplay,
						gameType: d.gameType,
						firstReleaseDate: d.firstReleaseDate,
						releaseYear: d.releaseYear,
						coverImageId: d.coverImageId,
						platforms: d.platforms,
						genres: d.genres,
						developers: d.developers,
						publishers: d.publishers,
						editions: d.editions,
						expansionsNormalized: d.expansionsNormalized,
						extraCoverImageIds: d.extraCoverImageIds,
						similar: d.similar,
						websites: d.websites,
						externalGames: d.externalGames,
						popularity: d.popularity,
						status: d.status,
						sourceHash: d.sourceHash,
						deriveVersion: d.deriveVersion,
						derivedAt: new Date(),
					})),
				)
				.onConflictDoUpdate({
					target: titles.id,
					set: updateAllFrom(
						'slug',
						'name',
						'display_name',
						'summary',
						'summary_display',
						'game_type',
						'first_release_date',
						'release_year',
						'cover_image_id',
						'platforms',
						'genres',
						'developers',
						'publishers',
						'editions',
						'expansions_normalized',
						'extra_cover_image_ids',
						'similar',
						'websites',
						'external_games',
						'popularity',
						'status',
						'source_hash',
						'derive_version',
						'derived_at',
					),
				})
		}

		// Members and terms are rewritten wholesale per title. Deleting by
		// title_id (not by game_id) is what lets a game move between titles: the
		// old title drops it, the new one claims it via the conflict update.
		await tx.delete(titleTerms).where(inArray(titleTerms.titleId, titleIds))
		await tx.delete(titleMembers).where(inArray(titleMembers.titleId, titleIds))

		const memberRows = derived.flatMap((d) =>
			d.members.map((m) => ({ gameId: m.gameId, titleId: d.id, foldType: m.foldType })),
		)
		for (const chunk of chunks(memberRows, ROW_CHUNK)) {
			await tx
				.insert(titleMembers)
				.values(chunk)
				.onConflictDoUpdate({
					target: titleMembers.gameId,
					set: updateAllFrom('title_id', 'fold_type'),
				})
		}

		const termRows = derived.flatMap((d) =>
			d.terms.map((t) => ({
				titleId: d.id,
				term: t.term,
				termNorm: t.termNorm,
				kind: t.kind,
				weight: t.weight,
			})),
		)
		for (const chunk of chunks(termRows, ROW_CHUNK)) {
			await tx.insert(titleTerms).values(chunk).onConflictDoNothing()
		}
	})
}

/** `col = excluded.col` for each column, which is all every upsert here wants. */
function updateAllFrom(...columns: string[]): Record<string, ReturnType<typeof drizzleSql>> {
	return Object.fromEntries(columns.map((c) => [toCamel(c), drizzleSql.raw(`excluded."${c}"`)]))
}

function toCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
	for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

/** Remove titles that no longer exist — a root that folded into another title. */
export async function deleteTitles(titleIds: number[]): Promise<void> {
	if (titleIds.length === 0) return
	await db.transaction(async (tx) => {
		await tx.delete(titleTerms).where(inArray(titleTerms.titleId, titleIds))
		await tx.delete(titleMembers).where(inArray(titleMembers.titleId, titleIds))
		await tx.delete(titles).where(inArray(titles.id, titleIds))
	})
}
