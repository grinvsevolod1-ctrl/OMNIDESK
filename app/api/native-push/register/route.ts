import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import {
  type DevicePlatform,
  isNativePushConfigured,
  saveDeviceToken,
} from '@/lib/native-push'

export const runtime = 'nodejs'

interface RegisterBody {
  platform?: string
  token?: string
  appVersion?: string
}

/**
 * Called by the Capacitor native shell after the OS grants a push token
 * (APNs on iOS, FCM on Android). Stores it against the signed-in operator so
 * the dispatcher can deliver native pushes to this device.
 *
 * Auth: the WebView loads our origin first-party, so the session cookie is
 * present exactly like any other authenticated fetch. Admin is excluded because
 * device_push_tokens.manager_id references managers(id) and admin has no row
 * there — and the dispatcher only ever addresses manager/curator targets anyway.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isNativePushConfigured()) {
    return NextResponse.json({ ok: false }, { status: 503 })
  }

  const session = await getSession().catch(() => null)
  if (!session || session.role === 'admin') {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  let body: RegisterBody
  try {
    body = (await req.json()) as RegisterBody
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const platform = body.platform
  const token = body.token?.trim()
  if ((platform !== 'ios' && platform !== 'android') || !token) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  try {
    await saveDeviceToken(
      session.sub,
      platform as DevicePlatform,
      token,
      body.appVersion?.trim() || null,
    )
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
