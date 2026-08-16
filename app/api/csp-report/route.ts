import { NextResponse } from 'next/server'
import { clientIp } from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'
import { log } from '@/lib/server-log'

// Collector for Content-Security-Policy violation reports.
//
// The panel ships an ENFORCING, nonce-based CSP (emitted per-request from
// proxy.ts). The policy still carries `report-uri /api/csp-report`, so whenever
// the browser blocks a resource it also POSTs a JSON report here. We log each
// violation as structured JSON so the team can spot anything the policy breaks
// (e.g. a newly added external origin) in the pm2 logs and tighten accordingly.
//
// Two payload shapes are accepted:
//  - legacy `report-uri`:      { "csp-report": { ... } }
//  - modern `report-to`/Reporting API: [{ "type": "csp-violation", body: {...} }]
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type LegacyReport = { 'csp-report'?: Record<string, unknown> }
type ModernReport = { type?: string; body?: Record<string, unknown> }

export async function POST(request: Request): Promise<Response> {
  try {
    // Anti-flood: this endpoint is unauthenticated by nature (browsers post
    // here from the login page too) and every report writes log lines, so cap
    // both the per-IP request rate and the body size — otherwise it is a free
    // log-flooding / disk-filling vector.
    const guard = await rateLimit(
      `csp-report:${clientIp(request.headers)}`,
      30,
      60_000,
    )
    if (!guard.allowed) return new NextResponse(null, { status: 429 })

    const raw = await request.text()
    if (!raw) return new NextResponse(null, { status: 204 })
    if (raw.length > 16_384) return new NextResponse(null, { status: 413 })

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Some browsers send with an odd content-type; still try to record it.
      log.warn('csp', 'report_unparseable', { rawPreview: raw.slice(0, 500) })
      return new NextResponse(null, { status: 204 })
    }

    const reports: Record<string, unknown>[] = []
    if (Array.isArray(parsed)) {
      // Cap entries per request: a single huge Reporting-API batch must not
      // translate into thousands of log lines.
      for (const r of (parsed as ModernReport[]).slice(0, 20)) {
        if (r?.body) reports.push(r.body)
      }
    } else {
      const legacy = (parsed as LegacyReport)['csp-report']
      if (legacy) reports.push(legacy)
    }

    for (const r of reports) {
      // Only surface the fields that matter, to keep log lines compact.
      log.warn('csp', 'violation', {
        directive:
          r['effective-directive'] ?? r['violated-directive'] ?? r['effectiveDirective'],
        blockedUri: r['blocked-uri'] ?? r['blockedURL'],
        documentUri: r['document-uri'] ?? r['documentURL'],
        sourceFile: r['source-file'] ?? r['sourceFile'],
        lineNumber: r['line-number'] ?? r['lineNumber'],
      })
    }

    return new NextResponse(null, { status: 204 })
  } catch {
    return new NextResponse(null, { status: 204 })
  }
}
