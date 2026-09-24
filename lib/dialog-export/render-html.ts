import type { MediaType, Message } from '@/lib/types'
import {
  formatMskDate,
  formatMskDateTimeFull,
  formatMskTime,
  mskDayKey,
} from '@/lib/time'
import type { DialogExportPayload } from './types'

/**
 * Чистый рендер выгрузки диалога в самодостаточный HTML (инлайн-CSS, без
 * скриптов и внешних ресурсов) — открывается двойным кликом из папки/архива
 * на любом компьютере и телефоне. Никакого DOM и React: одна и та же функция
 * работает в браузере, на сервере и в vitest.
 *
 * Медиа не встраивается в HTML (data:-URI на сотни фото раздул бы файл до
 * гигабайт и подвесил бы браузер) — файлы лежат рядом в `media/`, а рендер
 * получает относительные пути через `mediaPath`. Если путь не отдан (медиа
 * не вложено по выбору или не скачалось), на его месте — текстовая плашка.
 */

export interface RenderOptions {
  /**
   * Относительный путь к файлу медиа для сообщения (например `media/001-
   * photo-ab12cd34.jpg`) или null, если файла в архиве нет.
   */
  mediaPath: (message: Message) => string | null
  /** Пользователь снял галочку «с медиафайлами» — плашки без пометки «сбой». */
  mediaOmitted: boolean
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  telegram_personal: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Лайв-чат сайта',
}

const MEDIA_LABELS: Record<MediaType, string> = {
  image: 'Фото',
  video: 'Видео',
  video_note: 'Видеосообщение',
  audio: 'Аудио',
  voice: 'Голосовое сообщение',
  sticker: 'Стикер',
  document: 'Файл',
}

/** Плейсхолдеры, которые ingest подставляет вместо пустой подписи к медиа. */
const MEDIA_PLACEHOLDER_BODIES = new Set([
  '[Фото]',
  '[Видео]',
  '[Видеосообщение]',
  '[Голосовое сообщение]',
  '[Аудио]',
  '[Стикер]',
  '[Файл]',
  '[Документ]',
])

function isPlaceholderBody(body: string): boolean {
  const b = body.trim()
  if (MEDIA_PLACEHOLDER_BODIES.has(b)) return true
  return b.startsWith('[Файл:') || b.endsWith('[Стикер]')
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Текст сообщения: экранирование + переносы строк + кликабельные ссылки. */
function renderBody(body: string): string {
  const escaped = escapeHtml(body)
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" rel="noopener noreferrer" target="_blank">${url}</a>`,
  )
  return linked.replace(/\r?\n/g, '<br>')
}

function channelLabel(type: string): string {
  return CHANNEL_LABELS[type] ?? type
}

function mediaLabel(type: MediaType | undefined): string {
  return type ? MEDIA_LABELS[type] : 'Вложение'
}

/** Стикеры в формате TGS (lottie) браузер не покажет — отдаём как файл. */
function isRenderableImage(m: Message): boolean {
  if (m.mediaType === 'image') return true
  if (m.mediaType !== 'sticker') return false
  const mime = (m.mediaMime ?? '').toLowerCase()
  return !mime.includes('tgsticker') && !mime.includes('lottie')
}

function renderMedia(m: Message, opts: RenderOptions): string {
  const label = mediaLabel(m.mediaType)
  const path = opts.mediaPath(m)
  if (!path) {
    const note = opts.mediaOmitted
      ? 'не вложено в выгрузку'
      : 'файл не удалось выгрузить'
    const name = m.mediaName ? ` · ${escapeHtml(m.mediaName)}` : ''
    return `<div class="media media-missing">${escapeHtml(label)}${name} <span class="muted">(${note})</span></div>`
  }
  const href = escapeHtml(path)
  const name = escapeHtml(m.mediaName || label)
  if (isRenderableImage(m)) {
    return `<a class="media media-image" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${escapeHtml(label)}" loading="lazy"></a>`
  }
  if (m.mediaType === 'video' || m.mediaType === 'video_note') {
    return `<div class="media media-video"><video controls preload="metadata" src="${href}"></video><a class="dl" href="${href}" download>${name}</a></div>`
  }
  if (m.mediaType === 'voice' || m.mediaType === 'audio') {
    return `<div class="media media-audio"><span class="media-title">${escapeHtml(label)}</span><audio controls preload="metadata" src="${href}"></audio><a class="dl" href="${href}" download>${name}</a></div>`
  }
  return `<div class="media media-file"><a class="dl" href="${href}" download>${escapeHtml(label)}: ${name}</a></div>`
}

function renderReply(m: Message): string {
  if (!m.replyTo) return ''
  const text = m.replyTo.body?.trim()
    ? escapeHtml(m.replyTo.body)
    : mediaLabel(m.replyTo.mediaType)
  return `<div class="reply"><span class="reply-author">${escapeHtml(m.replyTo.author || '')}</span><span class="reply-text">${text}</span></div>`
}

function renderReactions(m: Message): string {
  const list = m.reactions ?? []
  if (list.length === 0) return ''
  return `<div class="reactions">${list
    .map((r) => `<span class="reaction">${escapeHtml(r.emoji)}</span>`)
    .join('')}</div>`
}

function renderMessage(m: Message, opts: RenderOptions): string {
  const side = m.direction === 'out' ? 'out' : 'in'
  const parts: string[] = []
  parts.push(renderReply(m))
  if (m.mediaType) parts.push(renderMedia(m, opts))
  const showBody =
    m.body && !(m.mediaType && (isPlaceholderBody(m.body) || m.mediaType === 'sticker'))
  if (showBody) parts.push(`<div class="body">${renderBody(m.body)}</div>`)
  if (!m.mediaType && !showBody) parts.push('<div class="body muted">(пусто)</div>')
  parts.push(renderReactions(m))

  const flags: string[] = []
  if (m.editedAt) flags.push('<span class="flag">изменено</span>')
  if (m.deletedAt) {
    flags.push(
      `<span class="flag flag-deleted">удалено ${
        m.deletedOrigin === 'remote' ? 'собеседником' : 'сотрудником'
      }</span>`,
    )
  }
  if (m.status === 'failed') flags.push('<span class="flag flag-failed">не доставлено</span>')

  return `<article class="msg ${side}${m.deletedAt ? ' deleted' : ''}" id="m-${escapeHtml(m.id)}">
  <header><span class="author">${escapeHtml(m.author || (side === 'out' ? 'Сотрудник' : 'Кандидат'))}</span><time datetime="${escapeHtml(m.createdAt)}" title="${escapeHtml(formatMskDateTimeFull(m.createdAt))}">${escapeHtml(formatMskTime(m.createdAt))}</time>${flags.join('')}</header>
  ${parts.filter(Boolean).join('\n  ')}
</article>`
}

const STYLES = `
:root{color-scheme:light;--bg:#f2f3f5;--card:#fff;--fg:#1c1e21;--muted:#6b7280;--line:#e5e7eb;--in:#fff;--out:#dcf2ff;--accent:#2563eb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px 64px}
.head{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:20px}
.head h1{margin:0 0 6px;font-size:20px}
.head dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:10px 0 0;font-size:13px}
.head dt{color:var(--muted)}
.head dd{margin:0}
.notice{margin-top:10px;padding:8px 12px;border-radius:8px;background:#fff7ed;color:#9a3412;font-size:13px}
.day{display:flex;justify-content:center;margin:22px 0 12px}
.day span{background:#e4e6ea;color:#374151;border-radius:999px;padding:3px 12px;font-size:12px;font-weight:600}
.msg{max-width:78%;margin:6px 0;padding:8px 12px 8px;border-radius:14px;border:1px solid var(--line);background:var(--in);word-wrap:break-word;overflow-wrap:anywhere}
.msg.out{margin-left:auto;background:var(--out);border-color:#c7e6fb}
.msg.deleted{opacity:.7;border-style:dashed}
.msg header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:12px;color:var(--muted);margin-bottom:3px}
.msg .author{font-weight:600;color:#111827}
.msg.out .author{color:#0b4a7a}
.flag{font-style:italic}
.flag-deleted{color:#b91c1c}
.flag-failed{color:#b45309}
.body{white-space:normal}
.body a{color:var(--accent)}
.muted{color:var(--muted)}
.reply{border-left:3px solid var(--accent);padding:2px 8px;margin:2px 0 6px;font-size:13px;color:#374151;background:rgba(37,99,235,.06);border-radius:4px}
.reply-author{display:block;font-weight:600;color:var(--accent)}
.media{margin:4px 0 6px}
.media img{display:block;max-width:100%;max-height:420px;border-radius:10px}
.media video{display:block;max-width:100%;max-height:420px;border-radius:10px;background:#000}
.media audio{display:block;width:100%;max-width:360px;margin:4px 0}
.media-title{display:block;font-size:12px;color:var(--muted)}
.media .dl{display:inline-block;font-size:12px;color:var(--accent);margin-top:2px}
.media-missing{font-size:13px;color:#374151;background:#f3f4f6;border-radius:8px;padding:6px 10px}
.reactions{display:flex;gap:4px;margin-top:4px}
.reaction{font-size:13px;background:#eef2ff;border-radius:999px;padding:1px 7px}
.foot{margin-top:28px;text-align:center;font-size:12px;color:var(--muted)}
@media print{body{background:#fff}.msg{break-inside:avoid}}
`

/** Собрать полный HTML-документ выгрузки. */
export function renderDialogHtml(
  payload: DialogExportPayload,
  opts: RenderOptions,
): string {
  const { conversation: c, messages } = payload
  const title = `Диалог с ${c.contactName}`
  const meta: Array<[string, string]> = []
  meta.push(['Канал', channelLabel(c.channelType)])
  if (c.contactUsername) meta.push(['Ник', `@${c.contactUsername}`])
  else if (c.contactHandle) meta.push(['Контакт', c.contactHandle])
  if (c.curatorName) meta.push(['Менеджер по кадрам', c.curatorName])
  if (c.managerName) meta.push(['Передал', c.managerName])
  if (c.transferredToCuratorAt)
    meta.push(['Передан', formatMskDateTimeFull(c.transferredToCuratorAt)])
  meta.push(['Сообщений', String(messages.length)])
  if (messages.length > 0) {
    meta.push([
      'Период',
      `${formatMskDate(messages[0].createdAt)} — ${formatMskDate(
        messages[messages.length - 1].createdAt,
      )}`,
    ])
  }
  meta.push([
    'Выгружено',
    `${formatMskDateTimeFull(payload.exportedAt)} (МСК), ${payload.exportedBy.name}`,
  ])

  const mediaCount = messages.filter((m) => m.mediaType).length
  const attached = messages.filter((m) => m.mediaType && opts.mediaPath(m)).length

  const notices: string[] = []
  if (payload.truncated) {
    notices.push(
      'История длиннее лимита выгрузки: в файл попали самые свежие сообщения.',
    )
  }
  if (mediaCount > 0 && opts.mediaOmitted) {
    notices.push(`Вложения (${mediaCount}) не включены в выгрузку по выбору.`)
  } else if (mediaCount > 0 && attached < mediaCount) {
    notices.push(
      `Вложено файлов: ${attached} из ${mediaCount}. Остальные не удалось скачать — на их месте отмечено «файл не удалось выгрузить».`,
    )
  }

  const bodyParts: string[] = []
  let lastDay = ''
  for (const m of messages) {
    const day = mskDayKey(m.createdAt)
    if (day !== lastDay) {
      lastDay = day
      bodyParts.push(
        `<div class="day"><span>${escapeHtml(formatMskDate(m.createdAt))}</span></div>`,
      )
    }
    bodyParts.push(renderMessage(m, opts))
  }
  if (messages.length === 0) {
    bodyParts.push('<p class="muted" style="text-align:center">Сообщений нет.</p>')
  }

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main class="wrap">
<section class="head">
<h1>${escapeHtml(title)}</h1>
<dl>${meta
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('')}</dl>
${notices.map((n) => `<div class="notice">${escapeHtml(n)}</div>`).join('\n')}
</section>
${bodyParts.join('\n')}
<p class="foot">Время указано по Москве (МСК). Сообщения слева — кандидат, справа — сотрудник.</p>
</main>
</body>
</html>
`
}
