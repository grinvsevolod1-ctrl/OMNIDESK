import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Identity probe for the service worker's push gate. Returns the id of the
 * operator CURRENTLY signed in on this device, or null when there is no live
 * session. `getSession()` re-validates the session version against the DB, so
 * this returns null not only after a normal sign-out but also after a forced
 * "log out other devices", a password change, or an account block.
 *
 * The SW compares this against the `userId` stamped on each message push and
 * refuses to show notifications addressed to anyone but the current user —
 * fixing "logged out but still receiving the previous account's notifications".
 * No-store so the answer is never cached across a login/logout.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getSession().catch(() => null)
  return NextResponse.json(
    { userId: session?.sub ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
