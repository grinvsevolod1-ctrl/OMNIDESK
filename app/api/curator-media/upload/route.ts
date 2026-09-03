import { NextResponse } from 'next/server'
import {
  sendCuratorVkMediaAction,
  sendCuratorWhatsappMediaAction,
} from '@/app/actions/curator-media'
import { getSession } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * POST /api/curator-media/upload — отправка файла куратором в ПЕРЕДАННЫЙ ему
 * диалог WhatsApp/VK. Зеркало /api/chat-media/upload, но для роли curator:
 * ранний auth-чек здесь, полная проверка владения (по curator_id) и лимиты —
 * внутри curator-media экшенов.
 *
 * FormData: conversationId, channel ('whatsapp'|'vk'), file, caption?
 */
export async function POST(req: Request): Promise<NextResponse> {
  const session = await getSession()
  if (!session || session.role !== 'curator') {
    return NextResponse.json(
      { ok: false, message: 'Не авторизовано.' },
      { status: 401 },
    )
  }
  const guard = await rateLimit(`curator-upload:${session.sub}`, 40, 10 * 60_000)
  if (!guard.allowed) {
    return NextResponse.json(
      {
        ok: false,
        message: `Слишком много отправок подряд. Повторите через ${Math.ceil(guard.retryAfterSec / 60)} мин.`,
      },
      { status: 429 },
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json(
      { ok: false, message: 'Некорректное тело запроса.' },
      { status: 400 },
    )
  }

  const conversationId = String(form.get('conversationId') || '')
  const channel = String(form.get('channel') || '')
  if (!conversationId || (channel !== 'whatsapp' && channel !== 'vk')) {
    return NextResponse.json(
      { ok: false, message: 'Не указан диалог или канал.' },
      { status: 400 },
    )
  }

  try {
    const res =
      channel === 'vk'
        ? await sendCuratorVkMediaAction(conversationId, form)
        : await sendCuratorWhatsappMediaAction(conversationId, form)
    return NextResponse.json(res, { status: res.ok ? 200 : 422 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (/unauthorized|forbidden|redirect/i.test(msg)) {
      return NextResponse.json(
        { ok: false, message: 'Не авторизовано.' },
        { status: 401 },
      )
    }
    console.error('[api/curator-media] upload failed:', err)
    return NextResponse.json(
      { ok: false, message: 'Не удалось отправить файл. Попробуйте ещё раз.' },
      { status: 500 },
    )
  }
}
