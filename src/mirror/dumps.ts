import { igdbGet } from '../igdb/client.js'
import { columnsOf, type DumpType, type Endpoint } from './endpoints.js'

/**
 * IGDB Data Partner dump API.
 *
 * Two calls. `GET /v4/dumps` lists every endpoint with the timestamp of its
 * latest dump — cheap, and enough to decide whether a nightly run has anything
 * to do. `GET /v4/dumps/{endpoint}` then returns the column schema plus a
 * presigned S3 URL.
 *
 * That URL is valid for FIVE MINUTES. Never fetch it ahead of time, never
 * persist it, never log it: it is a bearer credential for the whole file.
 */

export interface DumpListEntry {
	endpoint: string
	/** Epoch SECONDS. Note the trap: `updated_at` inside the CSV is a formatted timestamp. */
	updated_at: number
}

export interface DumpDetail {
	endpoint: string
	file_name: string
	size_bytes: number
	updated_at: number
	/** Bumped by IGDB when the column set changes. Our drift tripwire. */
	schema_version: string
	/** Column name -> dump type. Insertion order matches the CSV header order. */
	schema: Record<string, DumpType>
	/** Presigned, 5-minute S3 URL. Absent from the copies saved under `.dumps/`. */
	s3_url?: string
}

export function listDumps(): Promise<DumpListEntry[]> {
	return igdbGet<DumpListEntry[]>('dumps')
}

export function getDump(endpoint: Endpoint): Promise<DumpDetail> {
	return igdbGet<DumpDetail>(`dumps/${endpoint}`)
}

/**
 * Refuse to load an endpoint whose shape has drifted.
 *
 * We only care about the columns we actually mirror. IGDB adding a column
 * upstream is normal and harmless — it bumps `schema_version` but we ignore
 * the column. A mirrored column vanishing or changing type is not harmless, and
 * the right response is to stop and let a human look, never to guess.
 */
export function checkSchema(endpoint: Endpoint, dumpSchema: Record<string, string>): string[] {
	const problems: string[] = []
	for (const [name, type] of columnsOf(endpoint)) {
		const actual = dumpSchema[name]
		if (actual === undefined) problems.push(`column "${name}" is gone from the dump`)
		else if (actual !== type) problems.push(`column "${name}" is now ${actual}, was ${type}`)
	}
	return problems
}

/**
 * Read just the header row of a CSV over HTTP, without downloading the file.
 *
 * `COPY … (FORMAT csv, HEADER true)` matches fields to columns POSITIONALLY —
 * it uses the header only to skip it, not to reorder. So the staging table has
 * to be built in the file's own column order, and that order has to come from
 * the file rather than from an assumption about the `schema` object.
 */
export async function fetchHeader(url: string): Promise<string[]> {
	const res = await fetch(url, { headers: { Range: 'bytes=0-65535' } })
	if (!res.ok && res.status !== 206) {
		throw new Error(`Header probe failed: ${res.status}`)
	}
	const text = await res.text()
	const nl = text.indexOf('\n')
	if (nl === -1) throw new Error('No newline in the first 64KB; not a CSV?')
	return parseHeader(text.slice(0, nl))
}

/**
 * Split a CSV header line.
 *
 * Header names are plain identifiers today, but quoting is cheap to honour and
 * the alternative is a silently misaligned COPY.
 */
export function parseHeader(line: string): string[] {
	const out: string[] = []
	let field = ''
	let quoted = false

	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"'
					i++
				} else quoted = false
			} else field += ch
		} else if (ch === '"') quoted = true
		else if (ch === ',') {
			out.push(field)
			field = ''
		} else if (ch !== '\r') field += ch
	}
	out.push(field)
	return out
}

export type { DumpType }
