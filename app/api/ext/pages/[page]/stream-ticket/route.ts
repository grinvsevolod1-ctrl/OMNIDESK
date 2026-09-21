import { NextResponse } from 'next/server'
import { issueStreamTicket } from '@/lib/god-sites'
import {
  bare401,
  bare404,
  bare429,
  CORS_HEADERS,
  corsPreflight,
  extIpGuard,
  readToken,
} from '../shared'

/**
 * POST /api/ext/pages/{PAGE_ID}/stream-ticket — mint a short-lived ticket for
 * the SSE `/stream` endpoint (#7). The token is sent as `Authorization: Bearer`
 * (a header, never the URL), validated against slug+token, and exchanged for a
 * ticket that the page then puts in `?ticket=` when opening EventSource. This
 * keeps the raw, long-lived token out of access logs.
 *
 * Auth/fail-closed is identical to /state and /bundle: a wrong token on a real
 * slug answers the same bare 404 as an unknown slug; a missing token is 401.
 */

export const dynamic = 'force-dynamic'

async function mint(
  req: Request,
  ctx: { params: Promise<{ page: string }> },
): Promise<Response> {
  const guard = await extIpGuard(req, 'stream-ticket', 60, 60_000)
  if (!guard.allowed) return bare429(guard.retryAfterSec)

  const token = readToken(req)
  if (!token) return bare401()

  const { page } = await ctx.params
  const ticket = await issueStreamTicket(page, token)
  if (!ticket) return bare404()

  return NextResponse.json(
    { ticket, expiresInMs: 60_000 },
    { headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } },
  )
}

export const POST = mint
// GET alias so a simple fetch without a body also works from the page.
export const GET = mint

export function OPTIONS(): Response {
  return corsPreflight()
}
