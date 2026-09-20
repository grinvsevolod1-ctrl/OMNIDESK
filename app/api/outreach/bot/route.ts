import { NextResponse } from 'next/server'
import { getBotSecrets } from '@/lib/data/outreach-config'
import { insertLead, pickManagerForLead } from '@/lib/data/outreach-leads'
import { publishRealtime } from '@/lib/realtime'

/**
 * Бот-приёмник лидов исходящего контура.
 *
 * Владелец пересылает боту сообщения из сторонней группы (или шлёт контакт/
 * @username). Telegram доставляет апдейт сюда вебхуком. Мы вытаскиваем контакт
 * лида, кладём его в очередь `outreach_leads` (дедуп по tg_user_id),
 * назначаем менеджеру round-robin и пушим realtime-событие, чтобы вкладка
 * «Исходящие» подсветила новый лид без перезагрузки.
 *
 * Вебхук защищён секретом Telegram (заголовок X-Telegram-Bot-Api-Secret-Token),
 * который генерируется при установке токена бота в god-панели.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface TgUser {
  id?: number
  first_name?: string
  last_name?: string
  username?: string
}

interface TgUpdate {
  message?: {
    message_id?: number
    text?: string
    caption?: string
    forward_from?: TgUser
    forward_sender_name?: string
    forward_origin?: {
      type?: string
      sender_user?: TgUser
      sender_user_name?: string
      chat?: { title?: string; username?: string }
    }
    contact?: {
      phone_number?: string
      first_name?: string
      last_name?: string
      user_id?: number
    }
    chat?: { title?: string; username?: string }
  }
}

/** Достаём @username из свободного текста (первое вхождение). */
function usernameFromText(text: string | undefined): string | null {
  if (!text) return null
  const m = text.match(/@([a-zA-Z0-9_]{4,32})/)
  return m ? m[1] : null
}

function fullName(u: TgUser | undefined, fallback?: string): string | null {
  if (u) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
    if (name) return name
  }
  return fallback?.trim() || null
}

export async function POST(req: Request) {
  const secrets = await getBotSecrets()
  // Бот не настроен — молча принимаем апдейт (Telegram не должен ретраить).
  if (!secrets) return NextResponse.json({ ok: true })

  // Проверка секрета вебхука: чужой POST не создаст лид.
  if (secrets.webhookSecret) {
    const got = req.headers.get('x-telegram-bot-api-secret-token')
    if (got !== secrets.webhookSecret) {
      return NextResponse.json({ ok: false }, { status: 401 })
    }
  }

  let update: TgUpdate
  try {
    update = (await req.json()) as TgUpdate
  } catch {
    return NextResponse.json({ ok: true })
  }

  const msg = update.message
  if (!msg) return NextResponse.json({ ok: true })

  const text = msg.text ?? msg.caption ?? ''
  const origin = msg.forward_origin
  const fwdUser = msg.forward_from ?? origin?.sender_user
  const contact = msg.contact

  // Определяем контакт лида: приоритет — числовой id пересланного автора,
  // затем контакт-визитка, затем @username из текста.
  const tgUserId =
    (fwdUser?.id ? String(fwdUser.id) : null) ??
    (contact?.user_id ? String(contact.user_id) : null)
  const username = fwdUser?.username ?? usernameFromText(text)
  const phone = contact?.phone_number ?? null
  const displayName =
    fullName(fwdUser) ??
    fullName(
      contact
        ? { first_name: contact.first_name, last_name: contact.last_name }
        : undefined,
    ) ??
    msg.forward_sender_name ??
    origin?.sender_user_name ??
    null
  const forwardedFrom =
    origin?.chat?.title ??
    origin?.chat?.username ??
    msg.chat?.title ??
    msg.forward_sender_name ??
    null

  // Нет ни одного идентификатора для связи — не создаём «пустой» лид, но и не
  // роняем вебхук: просто подтверждаем и подсказываем владельцу в боте.
  if (!tgUserId && !username && !phone) {
    await replyToBot(
      secrets.token,
      chatIdFrom(update),
      'Не нашёл контакт в пересланном сообщении. Убедитесь, что у автора открыт профиль, или пришлите @username / контакт.',
    ).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  const managerId = await pickManagerForLead()

  const { deduped } = await insertLead({
    source: 'telegram_bot',
    tgUserId,
    username,
    phone,
    displayName,
    rawText: text || null,
    forwardedFrom,
    assignedManagerId: managerId,
  })

  // Realtime-пуш менеджеру: вкладка «Исходящие» подсветит новый лид.
  if (managerId && !deduped) {
    await publishRealtime({
      type: 'lead',
      managerId,
      leadName: displayName ?? username ?? phone ?? 'Новый лид',
    }).catch(() => {})
  }

  await replyToBot(
    secrets.token,
    chatIdFrom(update),
    deduped
      ? `Этот лид уже в работе${displayName ? ` (${displayName})` : ''}.`
      : `Лид принят${displayName ? `: ${displayName}` : ''}${managerId ? ' и назначен менеджеру.' : ' (свободные менеджеры не найдены).'}`,
  ).catch(() => {})

  return NextResponse.json({ ok: true })
}

function chatIdFrom(update: TgUpdate): number | null {
  const anyChat = (update.message as unknown as { chat?: { id?: number } })?.chat
  return anyChat?.id ?? null
}

async function replyToBot(
  token: string,
  chatId: number | null,
  text: string,
): Promise<void> {
  if (!chatId) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
}
