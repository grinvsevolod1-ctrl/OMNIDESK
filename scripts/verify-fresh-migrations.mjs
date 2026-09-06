// Fresh-schema verifier: proves the full migration chain applies cleanly onto
// an EMPTY database and leaves zero pending, in the exact filename order CI/prod
// use. This is the guard that would have caught migration 164's constraint
// conflict (a CHECK that made a documented delete path impossible) BEFORE it
// reached a running database — the kind of drift a running-DB `migrate up` never
// re-exercises because those files are already marked applied.
//
// Run against a THROWAWAY database (its own schema is dropped and recreated):
//   DATABASE_URL=postgres://…/omnidesk_ci node scripts/verify-fresh-migrations.mjs
//
// Exits non-zero on: any migration SQL error, a checksum mismatch, or any
// remaining pending file after the run.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is required (point it at a throwaway CI database).')
  process.exit(1)
}

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

// 1) Reset to a truly empty public schema so we exercise the fresh-install path,
//    not an incremental top-up.
const admin = new pg.Client({ connectionString: databaseUrl })
await admin.connect()
try {
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE')
  await admin.query('CREATE SCHEMA public')
} finally {
  await admin.end()
}
console.log('Reset public schema to empty.')

// 2) Apply the whole chain via the SAME migrate.mjs prod/CI uses. Inherit stdio
//    so a failing migration's error is visible in the CI log; a non-zero exit
//    (SQL error or modified-checksum guard) fails this job.
const up = spawnSync('node', [path.join(scriptsDir, 'migrate.mjs'), 'up'], {
  stdio: 'inherit',
  env: process.env,
})
if (up.status !== 0) fail(`migrate up exited with code ${up.status}`)

// 3) Assert zero pending: every .sql file on disk must be recorded applied.
//    (migrate.mjs already errors on SQL failures; this catches a file that was
//    added but somehow never ran, and confirms the tracking table is complete.)
const onDisk = readdirSync(scriptsDir)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort()

const verify = new pg.Client({ connectionString: databaseUrl })
await verify.connect()
try {
  const { rows } = await verify.query('SELECT filename FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.filename))
  const pending = onDisk.filter((f) => !applied.has(f))
  if (pending.length > 0) {
    fail(`${pending.length} migration(s) never applied:\n  ${pending.join('\n  ')}`)
  }
  // Sanity: schema is non-trivial (a silent no-op chain would be a red flag).
  const { rows: tbls } = await verify.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  )
  if (tbls[0].n < 10) fail(`only ${tbls[0].n} tables created — chain looks incomplete`)
  console.log(
    `\n✓ Fresh install clean: ${onDisk.length} migrations applied, ${tbls[0].n} tables, 0 pending.`,
  )
} finally {
  await verify.end()
}
