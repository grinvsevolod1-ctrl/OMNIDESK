import { NextResponse } from 'next/server'
import {
  sendVkMediaAction,
  sendWhatsappMediaAction,
} from '@/app/actions/account'

export const runtime = 'nodejs'
// Files stream to the provider (WhatsApp Graph / VK) through the account's
// proxy — big uploads need generous time.
export const maxDuration = 120

/**
 * POST /api/chat-media/upload — отправка файла в диалог WhatsApp/VK.
 *
 * Обычный fetch-роут вместо вызова server action из клиента: POST экшена с
 * крупным видео обрезается прокси-слоями (nginx и т.п.) ДО обработчика Next,
 * и клиент получает генерик «An unexpected response was received from the
 * server». Роут отвечает честным JSON и статусом. Вся логика и проверки —
 * в существующих экшенах (requireManager, владение диалогом, лимиты).
 *
 * FormData: conversationId, channel ('whatsapp'|'vk'), file, caption?
 */
export async function POST(req: Request): Promise<NextResponse> {
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
        ? await sendVkMediaAction(conversationId, form)
        : await sendWhatsappMediaAction(conversationId, form)
    return NextResponse.json(res, { status: res.ok ? 200 : 422 })
  } catch (err) {
    // requireManager() бросает при отсутствии сессии; остальное — сбои провайдера.
    const msg = err instanceof Error ? err.message : ''
    if (/unauthorized|forbidden|redirect/i.test(msg)) {
      return NextResponse.json(
        { ok: false, message: 'Не авторизовано.' },
        { status: 401 },
      )
    }
    console.error('[api/chat-media] upload failed:', err)
    return NextResponse.json(
      { ok: false, message: 'Не удалось отправить файл. Попробуйте ещё раз.' },
      { status: 500 },
    )
  }
}
