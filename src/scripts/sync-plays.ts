/**
 * One play sync pass: poll every linked account that is due, then exit.
 *
 *   deno task cron:sync
 *
 * The sleeping-deployment counterpart of the in-process worker in
 * `src/sync/worker.ts`, in the same way `cron:refresh` stands in for the dump
 * scheduler. Run it on a schedule at least as often as
 * PLAY_SYNC_INTERVAL_MINUTES; a run with nothing due does one query and exits.
 *
 * Safe to overlap with itself or the worker: accounts are claimed before they
 * are polled.
 */

import { sql } from '../db/client.js'
import { logger } from '../logger.js'
import { syncDue } from '../sync/run.js'

// Bound one run. Anything left over is still due and the next run takes it.
const MAX_ACCOUNTS = 1000

const started = Date.now()
const result = await syncDue(MAX_ACCOUNTS)

logger.info({ ...result, elapsedMs: Date.now() - started }, 'Play sync finished')

await sql.end()

// Non-zero only when every account failed: one private or broken profile is
// routine, but all of them failing means Steam or our key is down.
Deno.exit(result.synced > 0 && result.failed === result.synced ? 1 : 0)
