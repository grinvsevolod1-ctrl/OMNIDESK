#!/usr/bin/env node
// Weekly VACUUM ANALYZE for the VPS: refreshes the planner statistics and
// reclaims dead tuples on the hottest tables, so Postgres keeps picking the
// composite indexes instead of falling back to seq scans as data drifts.
//
// Driven by pm2 (`omnidesk-db-vacuum` in ecosystem.config.js) or crontab,
// e.g. Sundays at 04:30 (after the nightly backup, before business hours):
//
//   30 4 * * 0 cd /path/to/omnidesk && node --env-file=.env scripts/db-vacuum-analyze.mjs
//
// Safety: plain VACUUM (NOT FULL) never takes exclusive locks — reads and
// writes continue as normal, it only skips pages it cannot grab immediately.
// Each table is vacuumed in its own statement so one failure (e.g. a table
// that does not exist yet because migrations lag) never aborts the rest.

import 'dotenv/config'
import pg from 'pg'

const { Client } = pg

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[db-vacuum] DATABASE_URL is not set; skipping run')
  process.exit(0)
}

// Hot tables in write-frequency order. Everything else is small enough for
// autovacuum's defaults to handle on its own.
const HOT_TABLES = [
  'messages',
  'conversations',
  'media_blobs',
  'lead_cards',
  'lead_card_comments',
  'lead_attachments',
  'webhook_dead_letter',
  'channel_jobs',
  'login_attempts',
  'ai_run_log',
]

const client = new Client({
  connectionString: url,
  // VACUUM on a big messages table can legitimately take a while.
  statement_timeout: 30 * 60_000,
})

try {
  await client.connect()
} catch (err) {
  console.error('[db-vacuum] cannot connect:', err.message)
  process.exit(1)
}

let failed = 0
for (const table of HOT_TABLES) {
  const started = Date.now()
  try {
    // Identifiers cannot be parameterized; HOT_TABLES is a hardcoded
    // allowlist above, no user input reaches this string.
    await client.query(`VACUUM (ANALYZE) "${table}"`)
    console.log(`[db-vacuum] ${table}: ok (${Date.now() - started}ms)`)
  } catch (err) {
    // 42P01 = table does not exist (migration not applied yet) — fine.
    if (err?.code === '42P01') {
      console.log(`[db-vacuum] ${table}: skipped (table does not exist)`)
    } else {
      failed += 1
      console.error(`[db-vacuum] ${table}: FAILED — ${err.message}`)
    }
  }
}

await client.end()
process.exit(failed > 0 ? 1 : 0)
