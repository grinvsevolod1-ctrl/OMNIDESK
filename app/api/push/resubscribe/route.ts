import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { query } from '@/lib/db'
import { isPushConfigured, saveSubscription } from '@/lib/push'

export const runtime = 'nodejs'

interface ResubscribeBody {
  oldEndpoint?: string
  subscription?: {
    endpoint?: string
    keys?: { p256dh?: string; auth?: string }
  }
}

/**
 * Called by the service worker's `pushsubscriptionchange` handler when the
 * browser itself rotates or invalidates a push subscription (desktop Chrome
 * does this after updates or endpoint expiry). Without this, the old endpoint
 * goes dead server-side and the device silently stops receiving pushes until
 * the manager happens to reopen the panel.
 *
 * Auth: prefer the manager session cookie (SW fetches are same-origin and
 * carry cookies). If the SW fires while the session is expired, fall back to
 * proving ownership via the OLD endpoint — push endpoints are unguessable
 * capability URLs, and the new subscription inherits the old row's manager.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isPushConfigured()) {
    return NextResponse.json({ ok: false }, { status: 503 })
  }

  let body: ResubscribeBody
  try {
    body = (await req.json()) as ResubscribeBody
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const sub = body.subscription
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  // Resolve the manager: session cookie first, old-endpoint ownership second.
  let managerId: string | null = null
  const session = await getSession().catch(() => null)
  if (session && session.role === 'manager') {
    managerId = session.sub
  } else if (body.oldEndpoint) {
    const rows = await query<{ manager_id: string }>(
      'SELECT manager_id FROM push_subscriptions WHERE endpoint = $1',
      [body.oldEndpoint],
    ).catch(() => [])
    managerId = rows[0]?.manager_id ?? null
  }
  if (!managerId) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  try {
    await saveSubscription(
      managerId,
      { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      req.headers.get('user-agent'),
    )
    // The old endpoint is dead by definition of this event — drop its row.
    if (body.oldEndpoint && body.oldEndpoint !== sub.endpoint) {
      await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [
        body.oldEndpoint,
      ]).catch(() => {})
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
