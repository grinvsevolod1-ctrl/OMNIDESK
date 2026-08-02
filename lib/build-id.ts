import 'server-only'

import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Build identity for the update-notification system.
 *
 * The VPS deploy flow (deploy.sh / scripts/auto-deploy.mjs) builds into
 * `.next.new`, atomically swaps it to `.next`, then restarts PM2. That gives
 * two distinct signals:
 *
 *  - RUNTIME_BUILD_ID — the BUILD_ID this server process LOADED with (read
 *    once at module init). Changes only after the PM2 restart.
 *  - currentDiskBuildId() — the BUILD_ID currently ON DISK. Between the swap
 *    and the restart it already shows the NEW id, which is exactly the
 *    "update is being installed right now" window the UI warns about.
 *
 * In dev there is no BUILD_ID file — both return 'dev' and the watcher stays
 * silent.
 */

const DIST_DIR = process.env.NEXT_DIST_DIR || '.next'

function readBuildId(): string {
  try {
    return readFileSync(join(process.cwd(), DIST_DIR, 'BUILD_ID'), 'utf8').trim()
  } catch {
    return 'dev'
  }
}

/** BUILD_ID captured when this server process started. */
export const RUNTIME_BUILD_ID = readBuildId()

/** BUILD_ID currently on disk (re-read on every call — it's a tiny file). */
export function currentDiskBuildId(): string {
  return readBuildId()
}
