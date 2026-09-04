import { z } from 'zod'

/**
 * Config loader.
 *
 * Backend concept: "fail-fast configuration". Instead of reading
 * `process.env.WHATEVER` scattered across the codebase (and crashing at 2am
 * when one is missing/misspelled), we validate ALL environment variables here,
 * once, at startup. If something is wrong the server refuses to boot with a
 * clear error rather than failing mysteriously later.
 */

const EnvSchema = z.object({
	PORT: z.coerce.number().default(8000),

	// CORS: which front-end origins may call this API. Comma-separated -> array.
	ALLOWED_ORIGINS: z
		.string()
		.default('http://localhost:5173')
		.transform((s) =>
			s
				.split(',')
				.map((o) => o.trim())
				.filter(Boolean),
		),

	DATABASE_URL: z.string().url(),

	// IGDB auth (via Twitch).
	TWITCH_CLIENT_ID: z.string().min(1),
	TWITCH_CLIENT_SECRET: z.string().min(1),

	// Max IGDB requests per second for THIS process. IGDB's limit (4/s) is global
	// to our credentials. Since the mirror landed this is nearly idle — the only
	// live calls left are the dump loader and the §5.5 fallback for a game IGDB
	// created since our last dump — but the cap stays as a guard.
	IGDB_RATE_CAP: z.coerce.number().int().min(1).max(4).default(3),

	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
	// Pretty-print exactly which vars are bad, then hard-exit.
	console.error('Invalid environment configuration:')
	console.error(z.prettifyError(parsed.error))
	process.exit(1)
}

export const config = parsed.data
export type Config = typeof config
