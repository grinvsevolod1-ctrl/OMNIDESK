import { NextResponse } from 'next/server'
import {
  commitAutoSpend,
  normalizePeriod,
  stateForPeriod,
} from '@/lib/god-sites'
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
 * GET /api/ext/pages/{PAGE_ID}/state?period=<p> — the one REQUIRED endpoint
 * of the page3.html contract (§2). Returns the contract `State` for the
 * requested period; the page polls this and redraws itself.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  ctx: { params: Promise<{ page: string }> },
): Promise<Response> {
  // Per-IP flood guard: witrines poll this a few times a minute, so 120/min
  // is generous for legitimate use while capping abusive polling that would
  // otherwise hammer the DB (each hit resolves the site + rolls auto-spend).
  const guard = await extIpGuard(req, 'state', 120, 60_000)
  if (!guard.allowed) return bare429(guard.retryAfterSec)

  const resolved = await resolveSite(req, ctx.params, { touch: true })
  if (resolved === 'unauthorized') return bare401()
  if (!resolved) return bare404()

  // Lazy day rollover: first read of a new day banks yesterday's auto-spend
  // into the stored balance (no-op when auto-spend is off or already done).
  const site = await commitAutoSpend(resolved)

  const period = normalizePeriod(
    new URL(req.url).searchParams.get('period') ?? undefined,
  )
  return NextResponse.json(stateForPeriod(site.state, period), {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  })
}

export function OPTIONS(): Response {
  return corsPreflight()
}
