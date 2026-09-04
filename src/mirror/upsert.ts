import { sql } from '../db/client.js'
import { columnsOf, type DumpType, type Endpoint, tableName } from './endpoints.js'

/**
 * Upsert a single canonical row from JSON.
 *
 * The dump loader does not use this — `COPY` handles CSV natively. This is for
 * the two paths that deliver one entity at a time as JSON: the §5.5 fallback
 * for a game IGDB has created since our last dump, and (from Phase 4) webhook
 * deliveries. Both carry the same unexpanded shape as a CSV row, so one
 * function covers them.
 *
 * The coercion here exists because IGDB's JSON API and its CSV dumps disagree
 * about time: JSON sends `first_release_date` as epoch SECONDS, the CSV sends
 * `2015-05-19 00:00:00`. Getting that wrong silently dates every game to 1970.
 */

/**
 * IGDB's timestamps are UTC, but `new Date("2015-05-19 00:00:00")` parses a
 * bare datetime as LOCAL time — so on a UTC-6 machine every release date lands
 * six hours late, and the same code gives different answers in dev and prod.
 * Pin it to UTC explicitly.
 */
function asUtc(value: string): string {
	return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
		? `${value.replace(' ', 'T')}Z`
		: value
}

export function coerce(type: DumpType, value: unknown): unknown {
	if (value === null || value === undefined || value === '') return null

	switch (type) {
		case 'LONG':
		case 'INTEGER':
		case 'DOUBLE':
			return typeof value === 'number' ? value : Number(value)
		case 'BOOLEAN':
			return typeof value === 'boolean' ? value : value === 't' || value === 'true'
		case 'TIMESTAMP': {
			// IGDB's JSON sends epoch SECONDS where the CSV sends
			// "2015-05-19 00:00:00". Getting that wrong dates every game to 1970.
			//
			// Returned as an ISO string, not a Date: postgres.js cannot serialize a
			// Date through its dynamic-object insert form (it falls back to the
			// string serializer and throws). An unknown-typed text parameter is
			// coerced to the column's own type by Postgres, so this is exact.
			const date =
				typeof value === 'number' ? new Date(value * 1000) : new Date(asUtc(String(value)))
			return Number.isNaN(date.getTime()) ? null : date.toISOString()
		}
		case 'STRING':
		case 'UUID':
			return String(value)
		case 'LONG[]':
		case 'INTEGER[]': {
			if (!Array.isArray(value)) return null
			// An expanded relation ({id, name}) can appear if a caller asks for one;
			// we only ever store the id.
			return value.map((v) =>
				typeof v === 'object' && v !== null ? Number((v as { id: number }).id) : Number(v),
			)
		}
	}
}

export interface UpsertResult {
	changed: boolean
}

/**
 * Insert or update one canonical row.
 *
 * `changed` is false when IGDB's checksum matches what we already hold, which
 * lets callers skip marking a title dirty. An unchanged row is not rewritten,
 * so `mirror_updated_at` keeps meaning "when this row last actually moved".
 */
export async function upsertEntity(
	endpoint: Endpoint,
	row: Record<string, unknown>,
): Promise<UpsertResult> {
	const table = tableName(endpoint)
	const columns = columnsOf(endpoint)

	const id = row.id === undefined ? null : Number(row.id)
	if (id === null || Number.isNaN(id)) throw new Error(`${endpoint} row has no usable id`)

	const values: Record<string, unknown> = {}
	for (const [name, type] of columns) {
		if (!(name in row)) continue
		values[name] = coerce(type, row[name])
	}
	values.id = id

	const incoming = values.checksum === undefined ? null : values.checksum
	const [existing] = await sql<Array<{ checksum: string | null; deleted_at: Date | null }>>`
		select checksum, deleted_at from ${sql(table)} where id = ${id}
	`

	// Unchanged AND not tombstoned: nothing to do. A tombstoned row that
	// reappears upstream must still be revived, checksum or not.
	if (
		existing &&
		existing.deleted_at === null &&
		incoming !== null &&
		existing.checksum === incoming
	) {
		return { changed: false }
	}

	const names = Object.keys(values)
	const updateNames = names.filter((n) => n !== 'id')

	// postgres.js builds both clauses from the same object: `sql(obj, ...keys)`
	// is a column list in INSERT position and `col = $n` pairs in SET position.
	// It cannot be an `excluded.col` list, but it does not need to be — we are
	// holding the values, so assigning them directly is the same write.
	await sql`
		insert into ${sql(table)} ${sql(values, ...names)}
		on conflict (id) do update set ${sql(values, ...updateNames)},
			mirror_updated_at = now(), deleted_at = null
	`

	return { changed: true }
}

/**
 * Tombstone a row. Never a hard delete: user records in PDS repos are keyed by
 * IGDB id, and a deleted game still has to render from its last known data.
 * See §7.3 of docs/PLAN-igdb-mirror.md.
 */
export async function markDeleted(endpoint: Endpoint, id: number): Promise<void> {
	const table = tableName(endpoint)
	await sql`
		update ${sql(table)} set deleted_at = now(), mirror_updated_at = now()
		where id = ${id} and deleted_at is null
	`
}
