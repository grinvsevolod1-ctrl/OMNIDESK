import { NextResponse } from 'next/server'
import { removeSubscriptionByEndpoint } from '@/lib/push'

export const runtime = 'nodejs'

interface DetachBody {
  endpoint?: string
}

/**
 * Called by the service worker's push gate when a message push arrives on a
 * device that is no longer signed in as the addressed operator. It removes the
 * subscription row for THIS endpoint so the dispatcher stops targeting the
 * logged-out device — which both ends the leak permanently and keeps the
 * browser's silent-push budget healthy (a suppressed push with no shown
 * notification is only tolerated a few times).
 *
 * Deliberately session-less: the whole point is that no session exists here.
 * A push endpoint is an unguessable capability URL, so possessing it is proof
 * enough to unsubscribe that one device — the only power granted is to stop the
 * device's own deliveries, never to read anything.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: DetachBody
  try {
    body = (await req.json()) as DetachBody
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  if (!body.endpoint) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  try {
    await removeSubscriptionByEndpoint(body.endpoint)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
