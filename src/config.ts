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

	// ---- Freshness (Phase 4) ----
	// Shared secret IGDB echoes back in the X-Secret header on every webhook.
	// Required only when webhooks are enabled; without it we cannot tell a real
	// delivery from anyone who guessed the URL.
	IGDB_WEBHOOK_SECRET: z.string().min(16).optional(),

	// The externally reachable origin IGDB should POST to, e.g.
	// https://api.respawn.social. IGDB cannot reach localhost, which is why
	// webhooks stay off in development.
	PUBLIC_URL: z.string().url().optional(),

	// Off by default. Registering a localhost URL would create a webhook IGDB
	// can never deliver to, and five failed deliveries deactivate it.
	IGDB_WEBHOOKS_ENABLED: z
		.string()
		.default('false')
		.transform((v) => v === 'true'),

	// Run the nightly dump load in-process. Off by default so a dev machine does
	// not pull 700MB overnight.
	DUMP_SCHEDULE_ENABLED: z
		.string()
		.default('false')
		.transform((v) => v === 'true'),

	// UTC hour to load dumps at. IGDB regenerates them daily; 06:00 UTC is after
	// that and before European morning traffic.
	DUMP_LOAD_HOUR: z.coerce.number().int().min(0).max(23).default(6),

	// The derive worker drains dirty_titles over a LISTEN connection. Off by
	// default because it needs a process that stays alive, and the deployment
	// target is allowed to sleep — `deno task cron:refresh` does the same work
	// on a schedule instead. Turn it on for a long-lived instance, where it
	// makes an intra-day change visible in seconds rather than at the next run.
	DERIVE_WORKER_ENABLED: z
		.string()
		.default('false')
		.transform((v) => v === 'true'),

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
