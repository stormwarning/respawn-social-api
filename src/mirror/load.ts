import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import {
	checkSchema,
	type DumpDetail,
	fetchHeader,
	getDump,
	listDumps,
	parseHeader,
} from './dumps.js'
import {
	columnsOf,
	type Endpoint,
	ENDPOINT_NAMES,
	PG_TYPE,
	stagingTableName,
	tableName,
} from './endpoints.js'

/**
 * Nightly dump loader — layer 1 of docs/PLAN-igdb-mirror.md.
 *
 * The shape of a load is: stream the CSV straight into an unlogged staging
 * table, then diff staging against live on IGDB's own per-row `checksum` and
 * touch only the rows that actually changed. That diff is the whole point. A
 * naive truncate-and-reload would work, but it would mark all 374k games as
 * changed every night, and the derive layer keys off "what changed" to decide
 * what to recompute. A steady-state run should report zero changes.
 *
 * Nothing is ever hard-deleted. A row that vanishes from the dump gets
 * `deleted_at` set, because user records in PDS repos still point at its id.
 */

export interface LoadResult {
	endpoint: Endpoint
	status: 'loaded' | 'skipped' | 'aborted'
	reason?: string
	rowsLoaded: number
	rowsChanged: number
	rowsDeleted: number
	elapsedMs: number
}

export interface LoadOptions {
	/** Load even if `dump_runs` says we already have this dump. */
	force?: boolean
	/**
	 * Read `{dir}/{endpoint}.csv` and `{dir}/{endpoint}.meta.json` instead of
	 * downloading. For development against the files `.dumps/fetch.sh` leaves
	 * behind — a full re-download is 694 MB.
	 */
	localDir?: string
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Load every endpoint, one at a time. One endpoint's failure never stops the rest. */
export async function loadAll(options: LoadOptions = {}): Promise<LoadResult[]> {
	// One cheap call tells us which endpoints have a newer dump than we hold.
	let latest = new Map<string, number>()
	if (!options.localDir) {
		try {
			latest = new Map((await listDumps()).map((d) => [d.endpoint, d.updated_at]))
		} catch (error) {
			logger.warn({ error }, 'GET /dumps failed; falling back to per-endpoint checks')
		}
	}

	const results: LoadResult[] = []
	for (const endpoint of ENDPOINT_NAMES) {
		try {
			results.push(await loadEndpoint(endpoint, options, latest.get(endpoint)))
		} catch (error) {
			logger.error({ error, endpoint }, 'Dump load failed')
			results.push({
				endpoint,
				status: 'aborted',
				reason: error instanceof Error ? error.message : String(error),
				rowsLoaded: 0,
				rowsChanged: 0,
				rowsDeleted: 0,
				elapsedMs: 0,
			})
		}
	}
	return results
}

export async function loadEndpoint(
	endpoint: Endpoint,
	options: LoadOptions = {},
	latestUpdatedAt?: number,
): Promise<LoadResult> {
	const started = Date.now()
	const nothing = { rowsLoaded: 0, rowsChanged: 0, rowsDeleted: 0 }
	const done = (rest: Omit<LoadResult, 'endpoint' | 'elapsedMs'>): LoadResult => ({
		endpoint,
		elapsedMs: Date.now() - started,
		...rest,
	})

	const previous = await lastRun(endpoint)

	// Cheapest exit: the listing says the dump hasn't been regenerated since we
	// last loaded it. Saves the detail call and the download.
	if (!options.force && latestUpdatedAt !== undefined && previous === latestUpdatedAt) {
		return done({ status: 'skipped', reason: 'dump unchanged since last load', ...nothing })
	}

	const meta = options.localDir
		? await readLocalMeta(options.localDir, endpoint)
		: await getDump(endpoint)

	if (!options.force && previous === meta.updated_at) {
		return done({ status: 'skipped', reason: 'dump unchanged since last load', ...nothing })
	}

	// Drift tripwire. Abort THIS endpoint only; the others are still loadable.
	const problems = checkSchema(endpoint, meta.schema)
	if (problems.length > 0) {
		const reason = `schema drift (version ${meta.schema_version}): ${problems.join('; ')}`
		logger.error({ endpoint, problems, schemaVersion: meta.schema_version }, 'Refusing to load')
		return done({ status: 'aborted', reason, ...nothing })
	}

	// COPY matches CSV fields to columns positionally, so staging must be built
	// in the file's own order — read it from the file, don't infer it.
	const header = options.localDir
		? parseHeader(await readFirstLine(`${options.localDir}/${endpoint}.csv`))
		: await fetchHeader(requireUrl(meta))

	const missing = columnsOf(endpoint)
		.map(([name]) => name)
		.filter((name) => !header.includes(name))
	if (missing.length > 0) {
		return done({
			status: 'aborted',
			reason: `CSV header is missing mirrored columns: ${missing.join(', ')}`,
			...nothing,
		})
	}

	const staging = stagingTableName(endpoint)
	await createStaging(endpoint, staging, header)

	try {
		await copyInto(staging, options.localDir ? undefined : requireUrl(meta), options, endpoint)
		const counts = await mergeStaging(endpoint, staging)
		await recordRun(endpoint, meta, counts)
		logger.info({ endpoint, ...counts, elapsedMs: Date.now() - started }, 'Dump loaded')
		return done({ status: 'loaded', ...counts })
	} finally {
		await sql.unsafe(`drop table if exists ${quote(staging)}`)
	}
}

function requireUrl(meta: DumpDetail): string {
	if (!meta.s3_url) {
		throw new Error(
			'Dump metadata has no s3_url. The copies under .dumps/ have it stripped on purpose; use --local to read those files, or let this run fetch fresh metadata.',
		)
	}
	return meta.s3_url
}

async function readLocalMeta(dir: string, endpoint: Endpoint): Promise<DumpDetail> {
	const raw = await Deno.readTextFile(`${dir}/${endpoint}.meta.json`)
	return JSON.parse(raw) as DumpDetail
}

/** Read the first line of a large file without reading the file. */
async function readFirstLine(path: string): Promise<string> {
	using file = await Deno.open(path)
	const buffer = new Uint8Array(64 * 1024)
	const read = await file.read(buffer)
	const text = new TextDecoder().decode(buffer.subarray(0, read ?? 0))
	const nl = text.indexOf('\n')
	if (nl === -1) throw new Error(`No newline in the first 64KB of ${path}`)
	return text.slice(0, nl)
}

/**
 * Staging mirrors the CSV, not our table: every column in the header, in header
 * order. Columns we mirror get their real type so COPY does the parsing (and
 * fails loudly on a bad value); columns we ignore are `text` so a value we
 * never look at can't fail the load. Unlogged because it is thrown away at the
 * end of the run and does not need to survive a crash.
 */
async function createStaging(endpoint: Endpoint, staging: string, header: string[]) {
	const mirrored = new Map(columnsOf(endpoint))
	const columns = header.map((name) => {
		const type = mirrored.get(name)
		return `${quote(name)} ${type ? PG_TYPE[type] : 'text'}`
	})

	await sql.unsafe(`drop table if exists ${quote(staging)}`)
	await sql.unsafe(`create unlogged table ${quote(staging)} (${columns.join(', ')})`)
}

async function copyInto(
	staging: string,
	url: string | undefined,
	options: LoadOptions,
	endpoint: Endpoint,
) {
	const source: ReadableStream<Uint8Array> = url
		? await fetchBody(url)
		: (await Deno.open(`${options.localDir}/${endpoint}.csv`)).readable

	// The session's TimeZone decides how IGDB's bare "2015-05-19 00:00:00" casts
	// to timestamptz. It is pinned to UTC for every connection in db/client.ts.
	const writable = await sql
		.unsafe(`copy ${quote(staging)} from stdin (format csv, header true)`)
		.writable()

	await pipeline(Readable.fromWeb(source as never), writable)
	await sql.unsafe(`create index on ${quote(staging)} (id)`)
	await sql.unsafe(`analyze ${quote(staging)}`)
}

async function fetchBody(url: string): Promise<ReadableStream<Uint8Array>> {
	const res = await fetch(url)
	if (!res.ok || !res.body) {
		// Deliberately not logging the URL: it is a presigned credential.
		throw new Error(`Dump download failed: ${res.status}`)
	}
	return res.body
}

/**
 * Diff staging against live and apply only the difference.
 *
 * `is distinct from` (not `<>`) because a null checksum on either side must
 * count as a change, and `null <> null` is null, not true.
 */
async function mergeStaging(endpoint: Endpoint, staging: string) {
	const live = tableName(endpoint)
	const names = columnsOf(endpoint).map(([name]) => name)
	const cols = names.map(quote).join(', ')
	// `id` is the conflict target; the columns we own are set explicitly below.
	const updates = names
		.filter((name) => name !== 'id')
		.map((name) => `${quote(name)} = excluded.${quote(name)}`)
		.join(', ')

	const [{ rowsLoaded }] = await sql.unsafe<[{ rowsLoaded: number }]>(
		`select count(*)::int as "rowsLoaded" from ${quote(staging)}`,
	)

	const changed = await sql.unsafe(
		`insert into ${quote(live)} (${cols}, mirror_updated_at, deleted_at)
		 select ${names.map((n) => `s.${quote(n)}`).join(', ')}, now(), null
		 from ${quote(staging)} s
		 left join ${quote(live)} l on l.id = s.id
		 where l.id is null
		    or l.checksum is distinct from s.checksum
		    or l.deleted_at is not null
		 on conflict (id) do update set ${updates}, mirror_updated_at = now(), deleted_at = null`,
	)

	// Absent from the dump = deleted upstream. Tombstone, never remove: see §7.3.
	const deleted = await sql.unsafe(
		`update ${quote(live)} l set deleted_at = now()
		 where l.deleted_at is null
		   and not exists (select 1 from ${quote(staging)} s where s.id = l.id)`,
	)

	return { rowsLoaded, rowsChanged: changed.count, rowsDeleted: deleted.count }
}

/**
 * The `updated_at` we recorded for this endpoint's last successful load.
 *
 * Note the `Number()`. `dump_runs.updated_at` is int8, and postgres.js hands
 * int8 back as a STRING rather than assume it fits in a JS number — so
 * comparing it straight against IGDB's numeric `updated_at` is always false,
 * and every endpoint reloads every night. See src/mirror/copy.test.ts.
 */
async function lastRun(endpoint: Endpoint): Promise<number | null> {
	const rows = await sql<{ updated_at: string | null }[]>`
		select updated_at from dump_runs where endpoint = ${endpoint}
	`
	const value = rows[0]?.updated_at
	return value == null ? null : Number(value)
}

async function recordRun(
	endpoint: Endpoint,
	meta: DumpDetail,
	counts: { rowsLoaded: number; rowsChanged: number; rowsDeleted: number },
) {
	await sql`
		insert into dump_runs (
			endpoint, file_name, updated_at, schema_version,
			rows_loaded, rows_changed, rows_deleted, loaded_at
		) values (
			${endpoint}, ${meta.file_name}, ${meta.updated_at}, ${meta.schema_version},
			${counts.rowsLoaded}, ${counts.rowsChanged}, ${counts.rowsDeleted}, now()
		)
		on conflict (endpoint) do update set
			file_name = excluded.file_name,
			updated_at = excluded.updated_at,
			schema_version = excluded.schema_version,
			rows_loaded = excluded.rows_loaded,
			rows_changed = excluded.rows_changed,
			rows_deleted = excluded.rows_deleted,
			loaded_at = now()
	`
}
