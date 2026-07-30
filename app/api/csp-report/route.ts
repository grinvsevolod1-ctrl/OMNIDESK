import { NextResponse } from 'next/server'
import { log } from '@/lib/server-log'

// Collector for Content-Security-Policy violation reports.
//
// The panel ships CSP in Report-Only mode (see next.config.mjs): the browser
// does NOT block anything, it just POSTs a JSON report here whenever a resource
// would have been blocked by the policy. We log each violation as structured
// JSON so the team can watch pm2 logs for a while, confirm the policy doesn't
// break any real feature, then flip Report-Only → enforcing.
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
    const raw = await request.text()
    if (!raw) return new NextResponse(null, { status: 204 })

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
      for (const r of parsed as ModernReport[]) {
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
