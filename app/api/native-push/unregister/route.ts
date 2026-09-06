import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { removeDeviceToken } from '@/lib/native-push'

export const runtime = 'nodejs'

interface UnregisterBody {
  token?: string
}

/**
 * Called by the native shell on logout so the dispatcher stops delivering to a
 * signed-out device (the native mirror of unsubscribePushThisDevice). Scoped to
 * the current operator so one user can't drop another's token.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const session = await getSession().catch(() => null)
  if (!session) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  let body: UnregisterBody
  try {
    body = (await req.json()) as UnregisterBody
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const token = body.token?.trim()
  if (!token) return NextResponse.json({ ok: false }, { status: 400 })

  try {
    await removeDeviceToken(session.sub, token)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
