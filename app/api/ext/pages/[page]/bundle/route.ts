import { NextResponse } from 'next/server'
import { getVitrineBundle } from '@/lib/god-ext/bundle'
import {
  bare401,
  bare404,
  bare429,
  CORS_HEADERS,
  corsPreflight,
  extIpGuard,
  resolveSite,
} from '../shared'

/**
 * GET /api/ext/pages/{PAGE_ID}/bundle — the auto-update endpoint. Returns the
 * LATEST vitrine `{ version, html, app }` so an installed extension's loader
 * (content.js) can refresh its markup + logic without a reinstall.
 *
 * Auth is identical to /state (AGENTS.md §4 п.5, fail-closed): slug+token are
 * matched in ONE query — a wrong token on a real slug answers the same bare
 * 404 as an unknown slug; a missing token is the only 401. We do NOT touch
 * last_seen_at here (that belongs to the data poll, not the code fetch).
 */

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  ctx: { params: Promise<{ page: string }> },
): Promise<Response> {
  // Cheaper cap than /state: the bundle is fetched once per page open, not on
  // a polling loop, so 60/min per IP is plenty and blunts abusive scraping of
  // the (authenticated) code payload.
  const guard = await extIpGuard(req, 'bundle', 60, 60_000)
  if (!guard.allowed) return bare429(guard.retryAfterSec)

  const resolved = await resolveSite(req, ctx.params)
  if (resolved === 'unauthorized') return bare401()
  if (!resolved) return bare404()

  const bundle = await getVitrineBundle()
  return NextResponse.json(bundle, {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  })
}

export function OPTIONS(): Response {
  return corsPreflight()
}
