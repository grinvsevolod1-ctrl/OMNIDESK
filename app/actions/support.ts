'use server'

import { getSession } from '@/lib/auth'
import {
  recordSupportTicket,
  type SupportAttachmentMeta,
  type SupportDelivery,
  type SupportKind,
} from '@/lib/data/support-tickets'
import { logServerError } from '@/lib/server-log'

export interface SupportResult {
  ok: boolean
  error?: string
  delivery?: SupportDelivery
}

/** Telegram bots can upload at most 50 MB per file over the HTTP API. */
const TELEGRAM_MAX_UPLOAD = 50 * 1024 * 1024
/** Hard cap on how many files we forward per ticket (keeps the bot responsive). */
const MAX_ATTACHMENTS = 20
const TELEGRAM_TIMEOUT = 60_000

const ROLE_LABELS: Record<string, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  curator: 'Менеджер по кадрам',
  head: 'Руководитель',
  buyer: 'Медиабайер',
}

const KIND_LABELS: Record<SupportKind, string> = {
  problem: 'Проблема / ошибка',
  suggestion: 'Предложение по улучшению',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

/** Pick the Telegram send method + field name best suited to a file's type. */
function telegramMethodFor(type: string): {
  method: 'sendPhoto' | 'sendVideo' | 'sendDocument'
  field: 'photo' | 'video' | 'document'
} {
  if (type.startsWith('image/') && type !== 'image/gif') {
    return { method: 'sendPhoto', field: 'photo' }
  }
  if (type.startsWith('video/')) {
    return { method: 'sendVideo', field: 'video' }
  }
  return { method: 'sendDocument', field: 'document' }
}

/**
 * Open a support ticket. Anyone signed in may submit; the author is taken from
 * the session (never trusted from the client). The ticket is stored and then
 * forwarded to the owner's Telegram bot: a summary message followed by each
 * attachment. Files over Telegram's 50 MB upload limit are recorded but noted
 * as not forwarded rather than failing the whole submission.
 */
export async function submitSupportTicketAction(
  formData: FormData,
): Promise<SupportResult> {
  const session = await getSession()
  if (!session) return { ok: false, error: 'Требуется вход в систему.' }

  const kindRaw = String(formData.get('kind') ?? '').trim()
  const kind: SupportKind = kindRaw === 'suggestion' ? 'suggestion' : 'problem'
  const description = String(formData.get('description') ?? '').trim()

  if (description.length < 3) {
    return { ok: false, error: 'Опишите проблему или предложение подробнее.' }
  }
  if (description.length > 4000) {
    return { ok: false, error: 'Описание слишком длинное (макс. 4000 символов).' }
  }

  const files = formData
    .getAll('files')
    .filter((f): f is File => f instanceof File && f.size > 0)
    .slice(0, MAX_ATTACHMENTS)

  const attachments: SupportAttachmentMeta[] = files.map((f) => ({
    name: f.name || 'file',
    size: f.size,
    type: f.type || 'application/octet-stream',
    forwarded: f.size <= TELEGRAM_MAX_UPLOAD,
  }))

  const token = (process.env.TELEGRAM_ALERT_BOT_TOKEN ?? '').trim()
  const chatId = (process.env.TELEGRAM_ALERT_CHAT_ID ?? '').trim()

  let delivery: SupportDelivery = 'not_configured'

  if (token && chatId) {
    const roleLabel = ROLE_LABELS[session.role] ?? session.role
    const oversized = attachments.filter((a) => !a.forwarded)
    const header =
      `<b>${kind === 'problem' ? '🛠 Поддержка' : '💡 Предложение'}: ${escapeHtml(KIND_LABELS[kind])}</b>\n` +
      `👤 ${escapeHtml(session.name)} · ${escapeHtml(roleLabel)}\n` +
      `✉️ ${escapeHtml(session.email)}\n\n` +
      escapeHtml(description) +
      (files.length
        ? `\n\n📎 Вложений: ${files.length}` +
          (oversized.length
            ? `\n⚠️ Не отправлены (>50 МБ): ${oversized.map((a) => `${escapeHtml(a.name)} (${humanSize(a.size)})`).join(', ')}`
            : '')
        : '')

    let sentText = false
    let sentAll = true
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: header,
          parse_mode: 'HTML',
        }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT),
      })
      sentText = res.ok
      if (!res.ok) {
        sentAll = false
        logServerError('support telegram sendMessage failed', {
          status: res.status,
        })
      }
    } catch (err) {
      sentAll = false
      logServerError('support telegram sendMessage threw', { err })
    }

    // Forward each attachment that fits the upload limit.
    for (const file of files) {
      if (file.size > TELEGRAM_MAX_UPLOAD) continue
      const { method, field } = telegramMethodFor(file.type || '')
      try {
        const body = new FormData()
        body.set('chat_id', chatId)
        body.set(field, file, file.name || 'file')
        const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT),
        })
        if (!res.ok) {
          sentAll = false
          logServerError('support telegram attachment failed', {
            status: res.status,
            method,
            name: file.name,
          })
        }
      } catch (err) {
        sentAll = false
        logServerError('support telegram attachment threw', {
          err,
          name: file.name,
        })
      }
    }

    delivery = sentText && sentAll ? 'sent' : sentText ? 'partial' : 'failed'
  }

  try {
    await recordSupportTicket({
      kind,
      authorSub: session.sub,
      authorName: session.name,
      authorEmail: session.email,
      authorRole: session.role,
      description,
      attachments,
      delivery,
    })
  } catch (err) {
    logServerError('support recordSupportTicket failed', { err })
    // The Telegram forward may still have succeeded; only fail hard if nothing
    // reached the owner at all.
    if (delivery === 'failed' || delivery === 'not_configured') {
      return {
        ok: false,
        error: 'Не удалось отправить обращение. Попробуйте ещё раз.',
      }
    }
  }

  if (delivery === 'failed') {
    return {
      ok: false,
      error: 'Не удалось доставить обращение в Telegram. Попробуйте позже.',
    }
  }

  return { ok: true, delivery }
}
