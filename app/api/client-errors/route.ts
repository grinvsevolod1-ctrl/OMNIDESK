import { NextResponse } from 'next/server'

import { clientIp } from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sink for the client-side ErrorReporter. Writes browser errors into the
 * server log with a [client-error] marker so they show up in `pm2 logs`
 * next to server-side errors. Strictly rate-limited and size-capped — this
 * endpoint must never become a log-flooding or disk-filling vector.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await rateLimit(
    `client-errors:${clientIp(request.headers)}`,
    20,
    60_000,
  )
  if (!guard.allowed) {
    return NextResponse.json({ ok: false }, { status: 429 })
  }

  let payload: Record<string, unknown> = {}
  try {
    const raw = await request.text()
    if (raw.length > 8_192) {
      return NextResponse.json({ ok: false }, { status: 413 })
    }
    payload = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const clean = (v: unknown, max: number) =>
    typeof v === 'string' ? v.slice(0, max) : undefined

  console.error(
    '[client-error]',
    JSON.stringify({
      message: clean(payload.message, 500) ?? 'unknown',
      stack: clean(payload.stack, 2000),
      source: clean(payload.source, 300),
      url: clean(payload.url, 300),
      ua: clean(payload.ua, 160),
      at: clean(payload.at, 40),
    }),
  )

  return NextResponse.json({ ok: true })
}
