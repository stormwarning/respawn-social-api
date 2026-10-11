import {
	bigint,
	date,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core'

/**
 * Play sync — gaming accounts a user has linked, and the plays we noticed on
 * them.
 *
 * None of the platforms tell us "you played X just now". What they do expose is
 * a running total of playtime per game, so a sync is: fetch the totals, compare
 * with the last fetch (`play_snapshots`), and turn every increase into a
 * `detected_plays` row for the user to confirm. Nothing here is ever written to
 * a PDS; the web app creates the log when the user says so.
 */

/**
 * One linked account, e.g. a Steam profile.
 *
 * Keyed by (provider, external_id) rather than by did: a Steam profile belongs
 * to one person, so a second did trying to link it is a conflict, not a second
 * row.
 */
export const linkedAccounts = pgTable(
	'linked_accounts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		did: text('did').notNull(),
		// 'steam'
		provider: text('provider').notNull(),
		// The platform's id for the account, e.g. a SteamID64.
		externalId: text('external_id').notNull(),
		// 'pending' until the first sync; then 'ok', 'private' (the platform hid
		// the library from us) or 'error'.
		status: text('status').notNull().default('pending'),
		lastError: text('last_error'),
		// When a sync last started, successful or not. The worker claims an account
		// by bumping this, so two runners never poll the same one.
		lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
		// When the first successful sync recorded the library. Until then a sync
		// is a baseline. Not inferable from `play_snapshots`: an empty library has
		// no rows either way.
		baselineAt: timestamp('baseline_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('linked_accounts_external').on(t.provider, t.externalId),
		index('linked_accounts_did_idx').on(t.did),
	],
)

/**
 * The last playtime totals we saw, one row per game in the account's library.
 *
 * An account's first sync is a baseline (see `linked_accounts.baseline_at`):
 * it records the totals and reports nothing, or linking a ten-year-old library
 * would bury the user under a decade of "new" plays.
 */
export const playSnapshots = pgTable(
	'play_snapshots',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => linkedAccounts.id, { onDelete: 'cascade' }),
		// The platform's id for the game, e.g. a Steam appid.
		externalGameId: text('external_game_id').notNull(),
		playtimeMinutes: integer('playtime_minutes').notNull(),
		lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
	},
	(t) => [primaryKey({ columns: [t.accountId, t.externalGameId] })],
)

/**
 * A play we noticed and the user has not yet dealt with.
 *
 * One row per game per (UTC) day: a long evening spans several polls, and each
 * poll adds its minutes to the same row instead of filing another.
 *
 * The title is NOT stored. It is looked up at read time through
 * `igdb_external_games` and `title_members`, so a game that folds into another
 * after we noticed it still shows under the title it belongs to now.
 */
export const detectedPlays = pgTable(
	'detected_plays',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		accountId: uuid('account_id')
			.notNull()
			.references(() => linkedAccounts.id, { onDelete: 'cascade' }),
		did: text('did').notNull(),
		provider: text('provider').notNull(),
		externalGameId: text('external_game_id').notNull(),
		// IGDB's `external_game_source` for the provider (1 = Steam), so the read
		// can join `igdb_external_games` without knowing about providers.
		externalGameSource: bigint('external_game_source', { mode: 'number' }).notNull(),
		// The platform's name for the game, shown when IGDB has no match.
		externalName: text('external_name'),
		minutes: integer('minutes').notNull(),
		playedOn: date('played_on').notNull(),
		lastPlayedAt: timestamp('last_played_at', { withTimezone: true }).notNull(),
		// 'pending' | 'logged' | 'dismissed'
		status: text('status').notNull().default('pending'),
		// The social.respawn.feed.log the user created from it, if they did.
		logUri: text('log_uri'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('detected_plays_day').on(t.accountId, t.externalGameId, t.playedOn),
		index('detected_plays_did_status_idx').on(t.did, t.status),
	],
)
