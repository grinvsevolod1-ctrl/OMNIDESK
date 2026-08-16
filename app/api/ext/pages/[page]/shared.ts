import 'server-only'

import { getSiteBySlugAndKey, type GodSite } from '@/lib/god-sites'

/**
 * Shared plumbing for the read-only page3.html contract:
 *   GET /api/ext/pages/{PAGE_ID}/state?period=<p>
 *   GET /api/ext/pages/{PAGE_ID}/stream?period=<p>&token=<t>   (SSE)
 *
 * PAGE_ID (the {page} path segment) = the site's slug in the god panel; the
 * token = the one-time API key (SHA-256 hash in the DB). The page sends the
 * token as `Authorization: Bearer <t>` for plain GETs and as `?token=` for
 * SSE (EventSource cannot set headers).
 *
 * FAIL-CLOSED (AGENTS.md §4 п.5): slug and token are matched in ONE query —
 * a valid slug with a wrong token answers the same bare 404 as a nonexistent
 * slug, so probing cannot learn which pages exist. The only non-404 failure
 * is a completely missing token → 401, which reveals nothing (every page
 * requires one, whether or not the slug exists).
 *
 * CORS: the mockup is a static page on a foreign domain; no cookies are
 * involved, the token is the only credential — a wildcard origin is safe.
 */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Page-Id',
  'Access-Control-Max-Age': '86400',
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export function bare404(): Response {
  return new Response(null, { status: 404, headers: CORS_HEADERS })
}

export function bare401(): Response {
  return new Response(null, { status: 401, headers: CORS_HEADERS })
}

/** Bearer header first (plain GET), ?token= as the SSE fallback. */
export function readToken(req: Request): string {
  const auth = req.headers.get('authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return new URL(req.url).searchParams.get('token')?.trim() ?? ''
}

/**
 * Resolve the site for a request. Returns:
 *  - GodSite  — slug+token matched (stamps last_seen_at when touch=true);
 *  - 'unauthorized' — no token supplied at all;
 *  - null — anything else (unknown slug OR wrong token → bare 404).
 */
export async function resolveSite(
  req: Request,
  params: Promise<{ page: string }>,
  opts?: { touch?: boolean },
): Promise<GodSite | 'unauthorized' | null> {
  const { page } = await params
  const token = readToken(req)
  if (!token) return 'unauthorized'
  return getSiteBySlugAndKey(page, token, opts)
}
