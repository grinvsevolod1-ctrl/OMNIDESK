import { NextResponse } from 'next/server'

import { RUNTIME_BUILD_ID, currentDiskBuildId } from '@/lib/build-id'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Version probe for the client-side update watcher.
 *
 * - `runtime` — the build this server process is executing.
 * - `disk`    — the build currently on disk. If it differs from `runtime`,
 *   a deploy has been swapped in and a PM2 restart is imminent: the UI shows
 *   the "update installing, please wait" overlay.
 *
 * The ids are opaque Next.js build hashes — no sensitive data — so the
 * endpoint is intentionally unauthenticated: the login page needs the update
 * overlay too.
 */
export function GET(): NextResponse {
  return NextResponse.json(
    { runtime: RUNTIME_BUILD_ID, disk: currentDiskBuildId() },
    { headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  )
}
