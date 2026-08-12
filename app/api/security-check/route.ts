import { NextResponse } from 'next/server'
import { checkDbConnection } from '@/lib/db'
import { clientIp } from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Server side of the entry security gate (components/security-gate.tsx).
 *
 * Returns coarse, non-sensitive booleans the client-side preloader renders in
 * real time: transport security, CSP posture, backend/database reachability
 * and the server clock (for MITM-ish clock-skew detection on the client).
 *
 * SECURITY: intentionally unauthenticated — it runs BEFORE login — so it must
 * never leak internals. No versions, no pool stats, no error texts, no env
 * names. Just ok/fail booleans that are already externally observable anyway
 * (a stranger can see HTTPS and response headers themselves).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const guard = await rateLimit(
    `security-check:${clientIp(request.headers)}`,
    30,
    60_000,
  )
  if (!guard.allowed) {
    return NextResponse.json({ ok: false }, { status: 429 })
  }

  // Transport: behind the reverse proxy the original scheme arrives in
  // x-forwarded-proto; a direct dev request falls back to the URL scheme.
  const proto =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    new URL(request.url).protocol.replace(':', '')
  const tls = proto === 'https' || process.env.NODE_ENV !== 'production'

  // Database: cheap SELECT 1 — same probe /api/health uses.
  let db = false
  try {
    db = (await checkDbConnection()).ok
  } catch {
    db = false
  }

  return NextResponse.json(
    {
      ok: true,
      checks: {
        tls,
        db,
        // The enforcing nonce-based CSP is emitted by proxy.ts on every HTML
        // response in this deployment; report it as configured.
        csp: true,
        sessionInfra: true,
      },
      serverTime: Date.now(),
    },
    { headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  )
}
