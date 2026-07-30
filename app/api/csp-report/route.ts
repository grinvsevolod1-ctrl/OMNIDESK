import { NextResponse } from 'next/server'
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
