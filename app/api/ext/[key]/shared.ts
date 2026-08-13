import 'server-only'

import { NextResponse } from 'next/server'
import { getSiteByApiKey, type GodSite } from '@/lib/god-sites'

/**
 * Shared plumbing for the /api/ext/<key>/* REST contract (external god-panel
 * managed sites — see lib/god-sites.ts and AGENTS.md §4).
 *
 * FAIL-CLOSED: an unknown/malformed key answers a bare 404 with an empty body,
 * indistinguishable from a route that does not exist. No WWW-Authenticate, no
 * JSON error — nothing that reveals the endpoint is alive.
 *
 * CORS: the mockup is a static page on a foreign domain. The key in the path
 * is the credential (no cookies involved), so a wildcard origin is safe: the
 * response is only useful to a caller that already knows the secret key.
 */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
  'Access-Control-Max-Age': '86400',
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export function bare404(): Response {
  return new Response(null, { status: 404, headers: CORS_HEADERS })
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  })
}

/** Resolve the site for a request; null → the caller must answer bare404(). */
export async function resolveSite(
  params: Promise<{ key: string }>,
  opts?: { touch?: boolean },
): Promise<GodSite | null> {
  const { key } = await params
  return getSiteByApiKey(key, opts)
}

/**
 * The client's known revision: If-Match header wins, body field is the
 * fallback (contract §5). Returns null when the client doesn't track
 * revisions — mutations then skip the conflict check.
 */
export function readRevision(
  req: Request,
  body: Record<string, unknown> | null,
): number | null {
  const header = req.headers.get('if-match')
  const raw = header ?? (body?.revision as unknown)
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Parse a JSON body, tolerating an empty or malformed one. */
export async function readBody(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const data = (await req.json()) as unknown
    return data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Map a MutationResult to the contract's HTTP responses. */
export function mutationResponse(
  res:
    | { ok: true; revision: number }
    | { ok: false; error: 'conflict'; revision: number }
    | { ok: false; error: 'not_found' }
    | { ok: false; error: 'invalid'; message: string },
  okBody?: Record<string, unknown>,
): Response {
  if (res.ok) return json({ ok: true, revision: res.revision, ...okBody })
  if (res.error === 'conflict') {
    return json({ error: 'revision conflict', revision: res.revision }, 409)
  }
  if (res.error === 'invalid') return json({ error: res.message }, 400)
  return bare404()
}
