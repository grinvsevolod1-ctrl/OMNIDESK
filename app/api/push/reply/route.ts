import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { sendMessageAction } from '@/app/actions/account-messaging'
import { sendCuratorMessageAction } from '@/app/actions/curator-messages'

/**
 * Inline reply from a web-push notification.
 *
 * The service worker (public/sw.js) POSTs here with the session cookie when the
 * operator types into the notification's "Ответить" text action. We send the
 * message under the operator's own identity by delegating to the same server
 * action the inbox uses — so channel routing, delivery, and receipts behave
 * identically to a reply typed in the UI. No new send path, no god-panel
 * coupling: this is an ordinary manager/curator send triggered from the OS.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  let body: { conversationId?: unknown; text?: unknown; role?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const conversationId =
    typeof body.conversationId === 'string' ? body.conversationId : ''
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!conversationId || !text) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  // Route by the caller's actual role — the require*-guards inside each action
  // enforce the correct scope, so a wrong 'role' hint can't cross a boundary.
  const result =
    session.role === 'curator'
      ? await sendCuratorMessageAction(conversationId, text)
      : session.role === 'manager'
        ? await sendMessageAction(conversationId, text)
        : { ok: false, message: 'Роль не поддерживает ответ из уведомления.' }

  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
