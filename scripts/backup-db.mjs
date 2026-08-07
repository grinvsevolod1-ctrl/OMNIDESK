#!/usr/bin/env node
// Nightly Postgres backup with rotation for the VPS.
//
// Dumps the whole database with pg_dump (custom format: compressed, works
// with pg_restore selective restore) into BACKUP_DIR and deletes dumps older
// than BACKUP_KEEP_DAYS. Driven by pm2 (see `omnidesk-backup-db` in
// ecosystem.config.js) or a plain crontab entry, e.g. nightly at 03:30:
//
//   30 3 * * * cd /path/to/omnidesk && node --env-file=.env scripts/backup-db.mjs
//
// Restore (into an empty database):
//   pg_restore --clean --if-exists -d "$DATABASE_URL" /path/to/omnidesk-YYYY-MM-DD-HHmm.dump
//
// Env:
//   DATABASE_URL       — required, same var the app uses.
//   BACKUP_DIR         — where to keep dumps (default: ~/omnidesk-backups).
//   BACKUP_KEEP_DAYS   — retention window in days (default: 7).

import 'dotenv/config'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[backup-db] DATABASE_URL is not set; skipping run')
  process.exit(0)
}

const backupDir =
  process.env.BACKUP_DIR || path.join(homedir(), 'omnidesk-backups')
const keepDays = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 7)

/** 2026-08-07-0330 — sortable, no colons (filesystem-safe). */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

async function main() {
  await mkdir(backupDir, { recursive: true })
  const file = path.join(backupDir, `omnidesk-${stamp()}.dump`)

  console.log(`[backup-db] dumping to ${file}`)
  const startedAt = Date.now()
  // Custom format (-Fc) is compressed and restorable table-by-table.
  // pg_dump reads the connection string directly — the password never
  // appears in `ps` output as a separate argument.
  await execFileAsync('pg_dump', ['-Fc', '--no-owner', '-f', file, url], {
    // A big database can take a while; 30 minutes is a generous ceiling.
    timeout: 30 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const { size } = await stat(file)
  console.log(
    `[backup-db] done in ${Math.round((Date.now() - startedAt) / 1000)}s, ${(size / 1024 / 1024).toFixed(1)} MB`,
  )
  if (size < 10 * 1024) {
    // A truncated/empty dump is worse than no dump: fail loudly so pm2 logs
    // show a nonzero exit instead of silently rotating good backups away.
    console.error('[backup-db] dump is suspiciously small — check pg_dump output')
    process.exit(1)
  }

  // Rotation: delete dumps older than the retention window.
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  const entries = await readdir(backupDir)
  let removed = 0
  for (const name of entries) {
    if (!name.startsWith('omnidesk-') || !name.endsWith('.dump')) continue
    const full = path.join(backupDir, name)
    const info = await stat(full)
    if (info.mtimeMs < cutoff) {
      await unlink(full)
      removed++
    }
  }
  if (removed > 0) console.log(`[backup-db] rotated out ${removed} old dump(s)`)
}

main().catch((err) => {
  console.error('[backup-db] failed:', err.message ?? err)
  process.exit(1)
})
