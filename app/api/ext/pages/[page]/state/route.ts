import { NextResponse } from 'next/server'
import { normalizePeriod, stateForPeriod } from '@/lib/god-sites'
import {
  bare401,
  bare404,
  CORS_HEADERS,
  corsPreflight,
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
  const site = await resolveSite(req, ctx.params, { touch: true })
  if (site === 'unauthorized') return bare401()
  if (!site) return bare404()

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
